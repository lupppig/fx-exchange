/**
 * Comprehensive FX-exchange E2E suite.
 *
 * Covers, end-to-end against a real Postgres + Redis:
 *   - Auth: register / verify / signin happy + every rejection path
 *   - Wallet funding: validation, idempotency, parallel safety
 *   - Legacy /wallet/convert: validation, insufficient balance, four-leg journal
 *   - FX /rates and /quotes: validation, spread, expiry, single-use semantics
 *   - /wallet/trade: cross-user theft, expiry, double-spend, idempotency
 *   - Transactions history: pagination, cursoring, cross-user isolation
 *   - Concurrency: Redlock + SELECT FOR UPDATE invariants under contention
 *   - Ledger invariant: sum(DEBIT) == sum(CREDIT) per currency per user
 *
 * Requires DATABASE_URL + REDIS_URL pointed at running infra. CI wires these.
 * The harness raises RATE_LIMIT_LIMIT to keep the global throttler out of the
 * way -- the suite is about correctness, not rate-limit policy.
 */

// Tighten throttler before AppModule loads. Per-route @Throttle decorators
// on auth endpoints still apply, so register/signin tests stay clear of
// the 5-per-minute caps by using fresh emails each time.
process.env.RATE_LIMIT_LIMIT = process.env.RATE_LIMIT_LIMIT ?? '100000';
process.env.RATE_LIMIT_TTL = process.env.RATE_LIMIT_TTL ?? '60';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.FX_QUOTE_TTL_SECONDS = process.env.FX_QUOTE_TTL_SECONDS ?? '5';

import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
  HttpStatus,
  BadRequestException,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { v4 as uuidv4 } from 'uuid';
import { DataSource } from 'typeorm';
import * as supertest from 'supertest';

import { AppModule } from '../src/app.module';
import { MailService } from '../src/common/mail/mail.service';
import { FxService } from '../src/fx/fx.service';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { TransactionStatus } from '../src/transactions/enums/transaction-status.enum';
import { TransactionType } from '../src/transactions/enums/transaction-type.enum';

// supertest's CJS default export differs between versions; both shapes work.
const request: typeof supertest =
  (supertest as unknown as { default?: typeof supertest }).default ?? supertest;

interface JournalEntryRow {
  type: TransactionType | 'DEBIT' | 'CREDIT';
  currency: string;
  amount: number | string;
  amountSubunits?: number | string;
}

interface ApiEnvelope<T> {
  success: boolean;
  timestamp: string;
  data: T;
}

interface ErrorEnvelope {
  success: false;
  statusCode: number;
  message: string;
}

const BASE = '/api/v1';
const PASSWORD = 'Password123!';

describe('FX Exchange E2E (comprehensive)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let http: ReturnType<typeof request>;

  // Captured OTP per email -- the auth flow emits one OTP per register call
  // and MailService is mocked to surface it here.
  const otpByEmail = new Map<string, string>();

  // Stable mid rates so quote/trade math is deterministic.
  //   NGN -> USD: 1 NGN = 0.0006 USD  (spread 50bps -> bid 0.000598500)
  const FX_RATES = {
    version: 'e2e-fixed',
    base: 'USD',
    timestamp: '2026-01-01T00:00:00.000Z',
    rates: {
      NGN: 1,
      USD: 0.0006,
      EUR: 0.00055,
      GBP: 0.00048,
    } as Record<string, number>,
  };

  const mockMailService = {
    sendOtp: jest
      .fn()
      .mockImplementation(async (email: string, otp: string) => {
        otpByEmail.set(email.toLowerCase(), otp);
      }),
  };

  const mockFxService = {
    getRates: jest.fn().mockResolvedValue(FX_RATES),
  };

  beforeAll(async () => {
    // No-op throttler storage: every increment reports 0 hits, so the
    // global ThrottlerGuard and every @Throttle()-decorated route always
    // pass. This is the correct seam to disable rate-limit policy for an
    // e2e correctness run -- overriding APP_GUARD/ThrottlerGuard does NOT
    // work because the decorator metadata is read inside ThrottlerGuard,
    // and the guard is resolved via DI from the storage token regardless.
    const noopThrottlerStorage = {
      increment: () =>
        Promise.resolve({
          totalHits: 0,
          timeToExpire: 0,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue(mockMailService)
      .overrideProvider(FxService)
      .useValue(mockFxService)
      .overrideProvider(ThrottlerStorage)
      .useValue(noopThrottlerStorage)
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: true });

    // Reproduce main.ts wiring -- the response envelope + error shape are
    // contract surface and the tests assert on them.
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.BAD_REQUEST,
        exceptionFactory: (errors) => {
          const message = errors
            .map((e) => Object.values(e.constraints || {}).join(', '))
            .join('; ');
          return new BadRequestException(message);
        },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
    app.useGlobalInterceptors(
      new TransformInterceptor(),
      new ClassSerializerInterceptor(app.get(Reflector)),
    );

    await app.init();
    dataSource = app.get(DataSource);
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // --- helpers ----------------------------------------------------------

  /** Create a freshly verified user and return its access token + email. */
  async function makeUser(): Promise<{ token: string; email: string }> {
    const email = `user-${uuidv4()}@example.com`;

    const reg = await http
      .post(`${BASE}/auth/register`)
      .send({ email, password: PASSWORD });
    expect(reg.status).toBe(HttpStatus.ACCEPTED);

    const otp = otpByEmail.get(email);
    expect(otp).toBeDefined();

    const ver = await http.post(`${BASE}/auth/verify`).send({ email, otp });
    expect([HttpStatus.OK, HttpStatus.CREATED]).toContain(ver.status);

    const si = await http
      .post(`${BASE}/auth/signin`)
      .send({ email, password: PASSWORD });
    expect(si.status).toBe(HttpStatus.OK);
    const token = (si.body as ApiEnvelope<{ access_token: string }>).data
      .access_token;
    expect(token).toBeDefined();

    return { token, email };
  }

  async function fund(
    token: string,
    currency: string,
    amount: number,
  ): Promise<supertest.Response> {
    return http
      .post(`${BASE}/wallet/fund`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', uuidv4())
      .send({ currency, amount });
  }

  async function getWallet(token: string): Promise<supertest.Response> {
    return http.get(`${BASE}/wallet`).set('Authorization', `Bearer ${token}`);
  }

  function balanceOf(walletRes: supertest.Response, currency: string): bigint {
    const body = walletRes.body as ApiEnvelope<{
      balances: Array<{ currency: string; balanceSubunits: string | number }>;
    }>;
    const row = body.data.balances.find((b) => b.currency === currency);
    // The Balance entity serializes its subunit amount via the
    // `balanceSubunits` getter (the raw `amount` column is @Exclude'd).
    return row ? BigInt(row.balanceSubunits) : 0n;
  }

  // ----------------------------------------------------------------------
  // Auth
  // ----------------------------------------------------------------------
  describe('Auth flow', () => {
    it('registers, verifies, and signs in', async () => {
      const { token } = await makeUser();
      expect(token).toMatch(/\..+\./); // looks like a JWT
    });

    it('rejects duplicate registration', async () => {
      const email = `dup-${uuidv4()}@example.com`;
      const first = await http
        .post(`${BASE}/auth/register`)
        .send({ email, password: PASSWORD });
      expect(first.status).toBe(HttpStatus.ACCEPTED);

      const second = await http
        .post(`${BASE}/auth/register`)
        .send({ email, password: PASSWORD });
      expect(second.status).toBe(HttpStatus.BAD_REQUEST);
      const err = second.body as ErrorEnvelope;
      expect(err.success).toBe(false);
      expect(String(err.message).toLowerCase()).toMatch(
        /exist|registered|already/,
      );
    });

    it('rejects weak passwords', async () => {
      const res = await http
        .post(`${BASE}/auth/register`)
        .send({ email: `weak-${uuidv4()}@example.com`, password: 'weakpass' });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects malformed email', async () => {
      const res = await http
        .post(`${BASE}/auth/register`)
        .send({ email: 'not-an-email', password: PASSWORD });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects missing fields', async () => {
      const res = await http.post(`${BASE}/auth/register`).send({});
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects wrong otp on verify', async () => {
      const email = `bad-otp-${uuidv4()}@example.com`;
      await http
        .post(`${BASE}/auth/register`)
        .send({ email, password: PASSWORD });
      const res = await http
        .post(`${BASE}/auth/verify`)
        .send({ email, otp: '000000' });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects malformed otp', async () => {
      const res = await http
        .post(`${BASE}/auth/verify`)
        .send({ email: 'whoever@example.com', otp: '123' });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects signin with unknown email', async () => {
      const res = await http
        .post(`${BASE}/auth/signin`)
        .send({ email: `nobody-${uuidv4()}@example.com`, password: PASSWORD });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects signin with wrong password', async () => {
      const { email } = await makeUser();
      const res = await http
        .post(`${BASE}/auth/signin`)
        .send({ email, password: 'WrongPass123!' });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects signin for unverified account', async () => {
      const email = `unverified-${uuidv4()}@example.com`;
      await http
        .post(`${BASE}/auth/register`)
        .send({ email, password: PASSWORD });
      // skip verify step
      const res = await http
        .post(`${BASE}/auth/signin`)
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects unauthenticated wallet access', async () => {
      const res = await http.get(`${BASE}/wallet`);
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('rejects malformed bearer token', async () => {
      const res = await http
        .get(`${BASE}/wallet`)
        .set('Authorization', 'NotBearer something');
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('rejects garbage JWT', async () => {
      const res = await http
        .get(`${BASE}/wallet`)
        .set('Authorization', 'Bearer not.a.jwt');
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  // ----------------------------------------------------------------------
  // Wallet funding
  // ----------------------------------------------------------------------
  describe('Wallet funding', () => {
    it('initial wallet has no balances', async () => {
      const { token } = await makeUser();
      const res = await getWallet(token);
      expect(res.status).toBe(HttpStatus.OK);
      const body = res.body as ApiEnvelope<{ balances: unknown[] }>;
      expect(body.data.balances).toEqual([]);
    });

    it('credits balance and reflects it in /wallet', async () => {
      const { token } = await makeUser();
      const res = await fund(token, 'NGN', 250_000);
      expect(res.status).toBe(HttpStatus.OK);
      const body = res.body as ApiEnvelope<{ status: TransactionStatus }>;
      expect(body.data.status).toBe(TransactionStatus.SUCCESS);

      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBe(250_000n);
    });

    it('rejects unsupported currency', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ currency: 'XYZ', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects lowercase currency (DTO requires uppercase)', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ currency: 'ngn', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects zero / negative / non-integer amount', async () => {
      const { token } = await makeUser();
      for (const amt of [0, -5, 1.5]) {
        const res = await http
          .post(`${BASE}/wallet/fund`)
          .set('Authorization', `Bearer ${token}`)
          .set('x-idempotency-key', uuidv4())
          .send({ currency: 'NGN', amount: amt });
        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('rejects amount exceeding the maximum', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ currency: 'NGN', amount: 100_000_000_001 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects missing idempotency key header', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currency: 'NGN', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('idempotent replay with same key returns the original journal', async () => {
      const { token } = await makeUser();
      const key = uuidv4();
      const payload = { currency: 'NGN', amount: 12_345 };

      const first = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', key)
        .send(payload);
      expect(first.status).toBe(HttpStatus.OK);

      const second = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', key)
        .send(payload);
      expect(second.status).toBe(HttpStatus.OK);

      const firstId = (first.body as ApiEnvelope<{ journal: { id: string } }>)
        .data.journal.id;
      const secondId = (second.body as ApiEnvelope<{ journal: { id: string } }>)
        .data.journal.id;
      expect(secondId).toBe(firstId);

      // Balance reflects exactly ONE credit, not two.
      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBe(12_345n);
    });

    it('different idempotency keys produce two distinct journal entries', async () => {
      const { token } = await makeUser();
      const a = await fund(token, 'NGN', 100);
      const b = await fund(token, 'NGN', 100);
      const aId = (a.body as ApiEnvelope<{ journal: { id: string } }>).data
        .journal.id;
      const bId = (b.body as ApiEnvelope<{ journal: { id: string } }>).data
        .journal.id;
      expect(aId).not.toBe(bId);

      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBe(200n);
    });
  });

  // ----------------------------------------------------------------------
  // Wallet convert (legacy mid-rate)
  // ----------------------------------------------------------------------
  describe('Wallet convert (mid-rate, legacy)', () => {
    async function userWithBalance(amountNGN: number) {
      const { token } = await makeUser();
      const r = await fund(token, 'NGN', amountNGN);
      expect(r.status).toBe(HttpStatus.OK);
      return token;
    }

    it('rejects same-currency convert (DTO validator)', async () => {
      const token = await userWithBalance(1_000);
      const res = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'NGN', toCurrency: 'NGN', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects unsupported currency', async () => {
      const token = await userWithBalance(1_000);
      const res = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'XYZ', toCurrency: 'USD', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects insufficient balance', async () => {
      const token = await userWithBalance(1_000);
      const res = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount: 999_999 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(JSON.stringify(res.body)).toMatch(/Insufficient NGN balance/i);
    });

    it('rejects amount that rounds to zero after conversion', async () => {
      const token = await userWithBalance(10_000);
      // 1 NGN subunit * 0.0006 USD-per-NGN = 0.0006 USD subunits -> floor 0
      const res = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount: 1 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('records a balanced four-leg journal entry and updates both balances', async () => {
      const token = await userWithBalance(500_000);
      const res = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount: 200_000 });
      expect(res.status).toBe(HttpStatus.OK);

      const journal = (
        res.body as ApiEnvelope<{ journal: { entries: JournalEntryRow[] } }>
      ).data.journal;
      const entries = journal.entries;

      // Four-leg ledger: user-from DEBIT, house-from CREDIT,
      //                  house-to  DEBIT, user-to   CREDIT
      const debits = entries.filter((e) => e.type === 'DEBIT');
      const credits = entries.filter((e) => e.type === 'CREDIT');
      expect(debits.length).toBe(2);
      expect(credits.length).toBe(2);

      const byCcyType = (
        ccy: string,
        type: 'DEBIT' | 'CREDIT',
      ): JournalEntryRow[] =>
        entries.filter((e) => e.currency === ccy && e.type === type);

      // Per-currency balance: debits == credits
      for (const ccy of ['NGN', 'USD']) {
        const d = byCcyType(ccy, 'DEBIT').reduce(
          (s, e) => s + BigInt(e.amountSubunits ?? e.amount),
          0n,
        );
        const c = byCcyType(ccy, 'CREDIT').reduce(
          (s, e) => s + BigInt(e.amountSubunits ?? e.amount),
          0n,
        );
        expect(d).toBe(c);
      }

      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBe(300_000n); // 500_000 - 200_000
      expect(balanceOf(w, 'USD')).toBe(120n); // 200_000 * 0.0006
    });

    it('idempotent replay returns the same result and does not double-debit', async () => {
      const token = await userWithBalance(500_000);
      const key = uuidv4();
      const body = { fromCurrency: 'NGN', toCurrency: 'USD', amount: 100_000 };

      const a = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', key)
        .send(body);
      expect(a.status).toBe(HttpStatus.OK);

      const b = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', key)
        .send(body);
      expect(b.status).toBe(HttpStatus.OK);

      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBe(400_000n);
      expect(balanceOf(w, 'USD')).toBe(60n);
    });
  });

  // ----------------------------------------------------------------------
  // FX rates + quotes
  // ----------------------------------------------------------------------
  describe('FX rates and quotes', () => {
    it('GET /fx/rates returns versioned mid rates', async () => {
      const { token } = await makeUser();
      const res = await http
        .get(`${BASE}/fx/rates`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(HttpStatus.OK);
      const body = res.body as ApiEnvelope<{
        version: string;
        rates: Record<string, number>;
      }>;
      expect(body.data.version).toBe(FX_RATES.version);
      expect(body.data.rates.NGN).toBe(1);
      expect(body.data.rates.USD).toBe(0.0006);
    });

    it('GET /fx/rates requires auth', async () => {
      const res = await http.get(`${BASE}/fx/rates`);
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('POST /fx/quotes returns bid/ask with spread applied (bid < mid < ask)', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          amountInSubunits: 1_000_000,
        });
      expect(res.status).toBe(HttpStatus.CREATED);
      const q = (
        res.body as ApiEnvelope<{
          id: string;
          fromCurrency: string;
          toCurrency: string;
          midRate: string;
          bid: string;
          ask: string;
          effectiveRate: string;
          expiresAt: string;
          amountInSubunits: string;
          amountOutSubunits: string;
        }>
      ).data;

      expect(q.id).toBeDefined();
      expect(q.fromCurrency).toBe('NGN');
      expect(q.toCurrency).toBe('USD');
      expect(Number(q.bid)).toBeLessThan(Number(q.midRate));
      expect(Number(q.ask)).toBeGreaterThan(Number(q.midRate));
      // user is selling NGN, gets BID side -- effectiveRate must equal bid.
      expect(q.effectiveRate).toBe(q.bid);
      expect(new Date(q.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(BigInt(q.amountInSubunits)).toBe(1_000_000n);
      expect(BigInt(q.amountOutSubunits)).toBeGreaterThan(0n);
    });

    it('rejects quote for same currency', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromCurrency: 'NGN',
          toCurrency: 'NGN',
          amountInSubunits: 1000,
        });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects quote for unsupported currency', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromCurrency: 'XYZ',
          toCurrency: 'USD',
          amountInSubunits: 1000,
        });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects quote with zero or negative amount', async () => {
      const { token } = await makeUser();
      for (const amt of [0, -1]) {
        const res = await http
          .post(`${BASE}/fx/quotes`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            fromCurrency: 'NGN',
            toCurrency: 'USD',
            amountInSubunits: amt,
          });
        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('rejects a quote whose payout would round to zero subunits', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          amountInSubunits: 1,
        });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  // ----------------------------------------------------------------------
  // Trade execution against a quote
  // ----------------------------------------------------------------------
  describe('Trade execution', () => {
    async function fundedUser(ngn = 5_000_000) {
      const u = await makeUser();
      await fund(u.token, 'NGN', ngn);
      return u;
    }

    async function quoteFor(
      token: string,
      from: string,
      to: string,
      amountInSubunits: number,
    ) {
      const res = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fromCurrency: from, toCurrency: to, amountInSubunits });
      expect(res.status).toBe(HttpStatus.CREATED);
      return (
        res.body as ApiEnvelope<{
          id: string;
          effectiveRate: string;
          amountInSubunits: string;
          amountOutSubunits: string;
        }>
      ).data;
    }

    it('fills a fresh quote: balances and journal align', async () => {
      const { token } = await fundedUser(2_000_000);
      const q = await quoteFor(token, 'NGN', 'USD', 1_000_000);

      const res = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId: q.id, idempotencyKey: uuidv4() });
      expect(res.status).toBe(HttpStatus.OK);

      const body = res.body as ApiEnvelope<{
        status: TransactionStatus;
        orderId: string;
        executedRate: string;
        amountInSubunits: string;
        amountOutSubunits: string;
        journal: { entries: JournalEntryRow[] };
      }>;
      expect(body.data.status).toBe(TransactionStatus.SUCCESS);
      expect(body.data.executedRate).toBe(q.effectiveRate);
      expect(body.data.amountInSubunits).toBe(q.amountInSubunits);
      expect(body.data.amountOutSubunits).toBe(q.amountOutSubunits);
      expect(body.data.journal.entries).toHaveLength(4);

      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBe(2_000_000n - BigInt(q.amountInSubunits));
      expect(balanceOf(w, 'USD')).toBe(BigInt(q.amountOutSubunits));
    });

    it('rejects an unknown quote id', async () => {
      const { token } = await fundedUser();
      const res = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId: uuidv4(), idempotencyKey: uuidv4() });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(JSON.stringify(res.body)).toMatch(
        /quote.*(expired|used|does not belong)/i,
      );
    });

    it('rejects a malformed quote id (DTO requires UUID)', async () => {
      const { token } = await fundedUser();
      const res = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId: 'not-a-uuid', idempotencyKey: uuidv4() });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("rejects another user's quote (cross-user theft prevention)", async () => {
      const owner = await fundedUser();
      const thief = await fundedUser();
      const q = await quoteFor(owner.token, 'NGN', 'USD', 100_000);

      const res = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${thief.token}`)
        .send({ quoteId: q.id, idempotencyKey: uuidv4() });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(JSON.stringify(res.body)).toMatch(
        /quote.*(expired|used|does not belong)/i,
      );

      // The legitimate owner can still redeem it: cross-user trade must
      // NOT have consumed the quote.
      const ok = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ quoteId: q.id, idempotencyKey: uuidv4() });
      expect(ok.status).toBe(HttpStatus.OK);
    });

    it('rejects a re-used quote (single-use semantics)', async () => {
      const { token } = await fundedUser();
      const q = await quoteFor(token, 'NGN', 'USD', 100_000);

      const first = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId: q.id, idempotencyKey: uuidv4() });
      expect(first.status).toBe(HttpStatus.OK);

      const replay = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        // fresh idempotency key so we go past the dedupe and hit the quote
        .send({ quoteId: q.id, idempotencyKey: uuidv4() });
      expect(replay.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects an expired quote', async () => {
      const { token } = await fundedUser();
      // Quote TTL is FX_QUOTE_TTL_SECONDS=5s (set at top of file). Wait just
      // past it so Redis evicts the quote, then the trade must be rejected.
      // The sleep exceeds jest's 5s default, so this test gets its own timeout.
      const q = await quoteFor(token, 'NGN', 'USD', 50_000);
      await new Promise((r) => setTimeout(r, 5500));
      const res = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId: q.id, idempotencyKey: uuidv4() });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    }, 15000);

    it('rejects trade with insufficient balance', async () => {
      const { token } = await makeUser();
      // No funding -- wallet is empty.
      const q = await quoteFor(token, 'NGN', 'USD', 1_000_000);
      const res = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId: q.id, idempotencyKey: uuidv4() });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(JSON.stringify(res.body)).toMatch(/Insufficient NGN balance/i);
    });

    it('idempotent trade replay returns cached result without consuming a new quote', async () => {
      const { token } = await fundedUser();
      const q = await quoteFor(token, 'NGN', 'USD', 100_000);
      const key = uuidv4();

      const first = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId: q.id, idempotencyKey: key });
      expect(first.status).toBe(HttpStatus.OK);

      // Replay with the same key -- even with a totally bogus quote id we
      // should hit the idempotency short-circuit BEFORE quote consumption.
      const second = await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId: uuidv4(), idempotencyKey: key });
      expect(second.status).toBe(HttpStatus.OK);
      const firstId = (first.body as ApiEnvelope<{ journal: { id: string } }>)
        .data.journal.id;
      const secondId = (second.body as ApiEnvelope<{ journal: { id: string } }>)
        .data.journal.id;
      expect(secondId).toBe(firstId);
    });
  });

  // ----------------------------------------------------------------------
  // Transactions history & pagination
  // ----------------------------------------------------------------------
  describe('Transactions history', () => {
    it('paginates with limit + cursor and orders newest-first', async () => {
      const { token } = await makeUser();
      // Create 7 journal entries (each fund is one journal).
      for (let i = 0; i < 7; i++) {
        const r = await fund(token, 'NGN', 100 + i);
        expect(r.status).toBe(HttpStatus.OK);
      }

      const page1 = await http
        .get(`${BASE}/transactions?limit=3`)
        .set('Authorization', `Bearer ${token}`);
      expect(page1.status).toBe(HttpStatus.OK);
      const p1 = (
        page1.body as ApiEnvelope<{
          items: Array<{ id: string; createdAt: string }>;
          nextCursor: string | null;
          hasNextPage: boolean;
        }>
      ).data;
      expect(p1.items).toHaveLength(3);
      expect(p1.hasNextPage).toBe(true);
      expect(p1.nextCursor).toBeDefined();
      // newest-first
      expect(
        new Date(p1.items[0].createdAt).getTime() >=
          new Date(p1.items[2].createdAt).getTime(),
      ).toBe(true);

      const page2 = await http
        .get(
          `${BASE}/transactions?limit=3&cursor=${encodeURIComponent(p1.nextCursor!)}`,
        )
        .set('Authorization', `Bearer ${token}`);
      const p2 = (
        page2.body as ApiEnvelope<{
          items: Array<{ id: string }>;
          hasNextPage: boolean;
        }>
      ).data;
      expect(p2.items.length).toBeGreaterThan(0);

      // No overlap between pages.
      const ids1 = new Set(p1.items.map((i) => i.id));
      for (const item of p2.items) expect(ids1.has(item.id)).toBe(false);
    });

    it("only returns the caller's transactions (cross-user isolation)", async () => {
      const a = await makeUser();
      const b = await makeUser();
      await fund(a.token, 'NGN', 111);
      await fund(b.token, 'NGN', 222);

      const aTx = await http
        .get(`${BASE}/transactions`)
        .set('Authorization', `Bearer ${a.token}`);
      const aItems = (
        aTx.body as ApiEnvelope<{ items: Array<{ userId: string }> }>
      ).data.items;
      // Every item must belong to user A.
      for (const item of aItems) {
        // userId may be undefined in the serialized shape; if present, check.
        if (item.userId) {
          // can't easily get A's userId here -- the contract we check is that
          // none of A's items show up in B's list.
        }
      }

      const bTx = await http
        .get(`${BASE}/transactions`)
        .set('Authorization', `Bearer ${b.token}`);
      const aIds = new Set(
        (
          aTx.body as ApiEnvelope<{ items: Array<{ id: string }> }>
        ).data.items.map((i) => i.id),
      );
      const bIds = (
        bTx.body as ApiEnvelope<{ items: Array<{ id: string }> }>
      ).data.items.map((i) => i.id);
      for (const id of bIds) expect(aIds.has(id)).toBe(false);
    });

    it('rejects limit out of range', async () => {
      const { token } = await makeUser();
      const tooLow = await http
        .get(`${BASE}/transactions?limit=0`)
        .set('Authorization', `Bearer ${token}`);
      expect(tooLow.status).toBe(HttpStatus.BAD_REQUEST);

      const tooHigh = await http
        .get(`${BASE}/transactions?limit=1000`)
        .set('Authorization', `Bearer ${token}`);
      expect(tooHigh.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects invalid cursor', async () => {
      const { token } = await makeUser();
      const res = await http
        .get(`${BASE}/transactions?cursor=not-an-iso-date`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('walks every page with limit=1 and sees each journal exactly once', async () => {
      // Regression guard for the keyset cursor: createdAt is timestamp(6) but
      // an ISO cursor only carries milliseconds. With limit=1 the cursor lands
      // on a boundary every page, so any precision loss would drop or repeat a
      // row. We assert a clean partition of all ids.
      const { token } = await makeUser();
      const N = 6;
      for (let i = 0; i < N; i++) {
        const r = await fund(token, 'NGN', 500 + i);
        expect(r.status).toBe(HttpStatus.OK);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < N + 5; page++) {
        const url = cursor
          ? `${BASE}/transactions?limit=1&cursor=${encodeURIComponent(cursor)}`
          : `${BASE}/transactions?limit=1`;
        const res = await http.get(url).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(HttpStatus.OK);
        const data = (
          res.body as ApiEnvelope<{
            items: Array<{ id: string }>;
            nextCursor: string | null;
            hasNextPage: boolean;
          }>
        ).data;
        for (const it of data.items) seen.push(it.id);
        if (!data.hasNextPage || !data.nextCursor) break;
        cursor = data.nextCursor;
      }

      expect(seen).toHaveLength(N);
      expect(new Set(seen).size).toBe(N); // no duplicates, no drops
    });

    it('filters by currency and still returns complete leg sets', async () => {
      // A convert journal has NGN and USD legs. Filtering by USD must select
      // that journal AND hydrate ALL its legs (not just the USD ones), or the
      // double-entry invariant downstream breaks.
      const { token } = await makeUser();
      await fund(token, 'NGN', 1_000_000);
      const conv = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount: 500_000 });
      expect(conv.status).toBe(HttpStatus.OK);

      const res = await http
        .get(`${BASE}/transactions?currency=USD`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(HttpStatus.OK);
      const items = (
        res.body as ApiEnvelope<{
          items: Array<{ purpose: string; entries: JournalEntryRow[] }>;
        }>
      ).data.items;

      // The pure-NGN funding journal has no USD leg -> excluded.
      // The convert journal has a USD leg -> included, with all four legs.
      const convertJournals = items.filter((j) => j.entries.length === 4);
      expect(convertJournals.length).toBeGreaterThan(0);
      for (const j of convertJournals) {
        const currencies = new Set(j.entries.map((e) => e.currency));
        // complete leg set: both sides present despite the USD-only filter
        expect(currencies.has('USD')).toBe(true);
        expect(currencies.has('NGN')).toBe(true);
      }
      // No funding-only (2-leg, NGN-only) journal leaked through the USD filter.
      const ngnOnly = items.filter(
        (j) => !new Set(j.entries.map((e) => e.currency)).has('USD'),
      );
      expect(ngnOnly).toHaveLength(0);
    });

    it('filters by type (CREDIT) selecting only journals with a matching leg', async () => {
      const { token } = await makeUser();
      await fund(token, 'NGN', 1234); // funding has a CREDIT(user) leg

      const res = await http
        .get(`${BASE}/transactions?type=${TransactionType.CREDIT}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(HttpStatus.OK);
      const items = (
        res.body as ApiEnvelope<{
          items: Array<{ entries: JournalEntryRow[] }>;
        }>
      ).data.items;
      expect(items.length).toBeGreaterThan(0);
      // every selected journal contains at least one CREDIT leg
      for (const j of items) {
        expect(j.entries.some((e) => e.type === 'CREDIT')).toBe(true);
      }
    });

    it('filters by purpose (FUNDING) excluding conversions', async () => {
      const { token } = await makeUser();
      await fund(token, 'NGN', 1_000_000);
      await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount: 200_000 });

      const res = await http
        .get(`${BASE}/transactions?purpose=FUNDING`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(HttpStatus.OK);
      const items = (
        res.body as ApiEnvelope<{ items: Array<{ purpose: string }> }>
      ).data.items;
      expect(items.length).toBeGreaterThan(0);
      for (const j of items) expect(j.purpose).toBe('FUNDING');
    });
  });

  // ----------------------------------------------------------------------
  // Concurrency & race conditions
  // ----------------------------------------------------------------------
  describe('Concurrency and races', () => {
    it('N parallel funds with distinct keys sum exactly to N * amount', async () => {
      const { token } = await makeUser();
      const N = 8;
      const each = 1_000;
      const responses = await Promise.all(
        Array.from({ length: N }, () => fund(token, 'NGN', each)),
      );
      responses.forEach((r) => expect(r.status).toBe(HttpStatus.OK));

      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBe(BigInt(N * each));
    });

    it('N parallel funds with the SAME key only credit once', async () => {
      const { token } = await makeUser();
      const key = uuidv4();
      const N = 5;
      const each = 7_777;
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          http
            .post(`${BASE}/wallet/fund`)
            .set('Authorization', `Bearer ${token}`)
            .set('x-idempotency-key', key)
            .send({ currency: 'NGN', amount: each }),
        ),
      );
      responses.forEach((r) => expect(r.status).toBe(HttpStatus.OK));

      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBe(BigInt(each));
    });

    it('parallel converts past balance: floor(balance/amount) succeed, rest fail INSUFFICIENT', async () => {
      const { token } = await makeUser();
      await fund(token, 'NGN', 300_000);

      const reqs = Array.from({ length: 5 }, () =>
        http
          .post(`${BASE}/wallet/convert`)
          .set('Authorization', `Bearer ${token}`)
          .set('x-idempotency-key', uuidv4())
          .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount: 100_000 }),
      );
      const responses = await Promise.all(reqs);
      const ok = responses.filter((r) => r.status === HttpStatus.OK).length;
      const bad = responses.filter(
        (r) => r.status === HttpStatus.BAD_REQUEST,
      ).length;
      expect(ok).toBe(3);
      expect(bad).toBe(2);

      // Balance can't be negative under any race.
      const w = await getWallet(token);
      expect(balanceOf(w, 'NGN')).toBeGreaterThanOrEqual(0n);
    });

    it('two parallel trades on the same quote: exactly one wins', async () => {
      const { token } = await makeUser();
      await fund(token, 'NGN', 2_000_000);
      const q = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          amountInSubunits: 1_000_000,
        });
      const quoteId = (q.body as ApiEnvelope<{ id: string }>).data.id;

      const [a, b] = await Promise.all([
        http
          .post(`${BASE}/wallet/trade`)
          .set('Authorization', `Bearer ${token}`)
          .send({ quoteId, idempotencyKey: uuidv4() }),
        http
          .post(`${BASE}/wallet/trade`)
          .set('Authorization', `Bearer ${token}`)
          .send({ quoteId, idempotencyKey: uuidv4() }),
      ]);

      const winners = [a, b].filter((r) => r.status === HttpStatus.OK).length;
      const losers = [a, b].filter(
        (r) => r.status === HttpStatus.BAD_REQUEST,
      ).length;
      expect(winners).toBe(1);
      expect(losers).toBe(1);
    });
  });

  // ----------------------------------------------------------------------
  // Ledger invariant: per-currency debits == credits in the user's journal
  // ----------------------------------------------------------------------
  describe('Ledger invariant', () => {
    it('sum(DEBIT) == sum(CREDIT) per currency across all of a user’s entries', async () => {
      const { token } = await makeUser();
      await fund(token, 'NGN', 1_000_000);
      // legacy convert
      await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount: 200_000 });
      // quote-driven trade
      const q = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromCurrency: 'NGN',
          toCurrency: 'EUR',
          amountInSubunits: 100_000,
        });
      const quoteId = (q.body as ApiEnvelope<{ id: string }>).data.id;
      await http
        .post(`${BASE}/wallet/trade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quoteId, idempotencyKey: uuidv4() });

      // Pull every page of /transactions and assert the invariant. We only
      // see the user's own legs here; the house legs balance them per
      // currency at the journal level, which we asserted in the convert
      // four-leg test.
      const all: JournalEntryRow[] = [];
      let cursor: string | undefined;
      // Hard cap on pages to keep the test bounded.
      for (let page = 0; page < 20; page++) {
        const url = cursor
          ? `${BASE}/transactions?limit=50&cursor=${encodeURIComponent(cursor)}`
          : `${BASE}/transactions?limit=50`;
        const res = await http.get(url).set('Authorization', `Bearer ${token}`);
        const data = (
          res.body as ApiEnvelope<{
            items: Array<{ entries: JournalEntryRow[] }>;
            nextCursor: string | null;
            hasNextPage: boolean;
          }>
        ).data;
        for (const j of data.items) {
          for (const e of j.entries) all.push(e);
        }
        if (!data.hasNextPage || !data.nextCursor) break;
        cursor = data.nextCursor;
      }

      // Per-currency over the FULL journals (user + house legs).
      const perCcy = new Map<string, { d: bigint; c: bigint }>();
      for (const e of all) {
        const slot = perCcy.get(e.currency) ?? { d: 0n, c: 0n };
        const amt = BigInt(e.amountSubunits ?? e.amount);
        if (e.type === 'DEBIT') slot.d += amt;
        else slot.c += amt;
        perCcy.set(e.currency, slot);
      }
      for (const [, { d, c }] of perCcy) {
        expect(d).toBe(c);
      }
    });
  });

  // ----------------------------------------------------------------------
  // Edge cases that need direct DB / state setup
  // ----------------------------------------------------------------------
  describe('Edge cases', () => {
    it('rejects funding when the house lacks liquidity for the currency', async () => {
      // Drain the house balance for an otherwise-unused currency to just below
      // the amount we fund, so the house leg would go negative. We isolate on
      // CHF (no other test touches it) and restore it afterwards so the run
      // stays order-independent.
      const { token } = await makeUser();
      const houseRow: Array<{ id: string; amount: string }> =
        await dataSource.query(
          `SELECT b.id, b.amount FROM balances b
             JOIN wallets w ON w.id = b."walletId"
            WHERE w."isSystem" = true AND b.currency = 'CHF'`,
        );
      expect(houseRow.length).toBe(1);
      const original = houseRow[0].amount;

      await dataSource.query(`UPDATE balances SET amount = $1 WHERE id = $2`, [
        '100',
        houseRow[0].id,
      ]);
      try {
        const res = await http
          .post(`${BASE}/wallet/fund`)
          .set('Authorization', `Bearer ${token}`)
          .set('x-idempotency-key', uuidv4())
          .send({ currency: 'CHF', amount: 1_000 });
        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
        expect(JSON.stringify(res.body)).toMatch(/House liquidity exhausted/i);
      } finally {
        await dataSource.query(
          `UPDATE balances SET amount = $1 WHERE id = $2`,
          [original, houseRow[0].id],
        );
      }
    });

    it('rejects replay of an idempotency key whose journal is PENDING', async () => {
      // Seed a PENDING journal directly, then replay the key via the API.
      const { token, email } = await makeUser();
      const userRow: Array<{ id: string }> = await dataSource.query(
        `SELECT id FROM users WHERE email = $1`,
        [email.toLowerCase()],
      );
      const userId = userRow[0].id;
      const wallet: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO wallets ("userId") VALUES ($1)
         ON CONFLICT DO NOTHING RETURNING id`,
        [userId],
      );
      const walletId =
        wallet[0]?.id ??
        (
          await dataSource.query(`SELECT id FROM wallets WHERE "userId" = $1`, [
            userId,
          ])
        )[0].id;

      const key = uuidv4();
      await dataSource.query(
        `INSERT INTO journal_entries ("walletId", "userId", purpose, status, "idempotencyKey")
         VALUES ($1, $2, 'FUNDING', 'PENDING', $3)`,
        [walletId, userId, key],
      );

      const res = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', key)
        .send({ currency: 'NGN', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(JSON.stringify(res.body)).toMatch(/being processed/i);
    });

    it('rejects replay of an idempotency key whose journal FAILED', async () => {
      const { token, email } = await makeUser();
      const userRow: Array<{ id: string }> = await dataSource.query(
        `SELECT id FROM users WHERE email = $1`,
        [email.toLowerCase()],
      );
      const userId = userRow[0].id;
      const wallet: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO wallets ("userId") VALUES ($1)
         ON CONFLICT DO NOTHING RETURNING id`,
        [userId],
      );
      const walletId =
        wallet[0]?.id ??
        (
          await dataSource.query(`SELECT id FROM wallets WHERE "userId" = $1`, [
            userId,
          ])
        )[0].id;

      const key = uuidv4();
      await dataSource.query(
        `INSERT INTO journal_entries ("walletId", "userId", purpose, status, "idempotencyKey")
         VALUES ($1, $2, 'FUNDING', 'FAILED', $3)`,
        [walletId, userId, key],
      );

      const res = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', key)
        .send({ currency: 'NGN', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(JSON.stringify(res.body)).toMatch(/previously failed/i);
    });

    it('rejects a whitespace-only idempotency key', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', '   ')
        .send({ currency: 'NGN', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects an idempotency key longer than 255 chars', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/wallet/fund`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', 'k'.repeat(256))
        .send({ currency: 'NGN', amount: 100 });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('convert idempotent replay returns the SAME journal id', async () => {
      const { token } = await makeUser();
      await fund(token, 'NGN', 1_000_000);
      const key = uuidv4();
      const body = { fromCurrency: 'NGN', toCurrency: 'USD', amount: 300_000 };

      const first = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', key)
        .send(body);
      expect(first.status).toBe(HttpStatus.OK);

      const second = await http
        .post(`${BASE}/wallet/convert`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-idempotency-key', key)
        .send(body);
      expect(second.status).toBe(HttpStatus.OK);

      const firstId = (first.body as ApiEnvelope<{ journal: { id: string } }>)
        .data.journal.id;
      const secondId = (second.body as ApiEnvelope<{ journal: { id: string } }>)
        .data.journal.id;
      expect(secondId).toBe(firstId);
    });

    it('rejects a quote with a non-integer amountInSubunits', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          amountInSubunits: 1.5,
        });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects a quote with a missing amountInSubunits', async () => {
      const { token } = await makeUser();
      const res = await http
        .post(`${BASE}/fx/quotes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fromCurrency: 'NGN', toCurrency: 'USD' });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  // Sanity hook: dataSource is set up. Pulled out so an init failure shows
  // here distinctly from the auth tests.
  it('data source is initialised', () => {
    expect(dataSource.isInitialized).toBe(true);
  });
});
