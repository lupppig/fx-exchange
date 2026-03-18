import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType, Reflector } from '@nestjs/common';
import { ClassSerializerInterceptor } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { MailService } from '../src/common/mail/mail.service.js';
import { FxService } from '../src/fx/fx.service.js';
import { TransactionStatus } from '../src/transactions/enums/transaction-status.enum.js';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor.js';
import { v4 as uuidv4 } from 'uuid';

describe('Application E2E (Comprehensive Flow)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtToken: string;
  let capturedOtp: string;
  const testEmail = `test-${uuidv4()}@example.com`;
  const testPassword = 'Password123!';

  // Mock MailService to capture OTP for the auth flow
  const mockMailService = {
    sendOtp: jest.fn().mockImplementation((_email, otp) => {
      capturedOtp = otp;
      return Promise.resolve();
    }),
  };

  // Mock FxService for stable, predictable rates
  const mockFxService = {
    getRates: jest.fn().mockResolvedValue({
      version: 'e2e-test-version',
      rates: { NGN: 1, USD: 0.0006, EUR: 0.00055 },
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue(mockMailService)
      .overrideProvider(FxService)
      .useValue(mockFxService)
      .compile();

    app = moduleFixture.createNestApplication();
    
    // Reproduce main.ts configuration exactly
    app.useGlobalPipes(new ValidationPipe({ 
      whitelist: true, 
      forbidNonWhitelisted: true, 
      transform: true 
    }));
    
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });

    app.useGlobalInterceptors(
      new TransformInterceptor(),
      new ClassSerializerInterceptor(app.get(Reflector)),
    );
    
    await app.init();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  const baseUrl = '/api/v1';

  describe('Authentication Flow', () => {
    it('/api/v1/auth/register (POST)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${baseUrl}/auth/register`)
        .send({ email: testEmail, password: testPassword });

      expect(res.status).toBe(201);
      expect(mockMailService.sendOtp).toHaveBeenCalled();
      expect(capturedOtp).toBeDefined();
    });

    it('/api/v1/auth/verify (POST)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${baseUrl}/auth/verify`)
        .send({ email: testEmail, otp: capturedOtp });

      expect([200, 201]).toContain(res.status);
    });

    it('/api/v1/auth/signin (POST)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${baseUrl}/auth/signin`)
        .send({ email: testEmail, password: testPassword });

      expect(res.status).toBe(201);
      // Access token is inside data due to TransformInterceptor
      expect(res.body.data.access_token).toBeDefined();
      jwtToken = res.body.data.access_token;
    });
  });

  describe('Wallet & Ledger Flow', () => {
    it('/api/v1/wallet (GET) - Initial State', async () => {
      const res = await request(app.getHttpServer())
        .get(`${baseUrl}/wallet`)
        .set('Authorization', `Bearer ${jwtToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.balances).toEqual([]);
    });

    it('/api/v1/wallet/fund (POST) - With Idempotency', async () => {
      const idempotencyKey = uuidv4();
      const payload = { currency: 'NGN', amount: 500000 };

      const res1 = await request(app.getHttpServer())
        .post(`${baseUrl}/wallet/fund`)
        .set('Authorization', `Bearer ${jwtToken}`)
        .set('x-idempotency-key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(200);
      expect(res1.body.data.status).toBe(TransactionStatus.SUCCESS);

      const res2 = await request(app.getHttpServer())
        .post(`${baseUrl}/wallet/fund`)
        .set('Authorization', `Bearer ${jwtToken}`)
        .set('x-idempotency-key', idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(200);
      expect(res2.body.data.message).toContain('idempotent');
      expect(res2.body.data.journal.id).toBe(res1.body.data.journal.id);
    });

    it('Concurrency Check: Parallel Funding', async () => {
      const amount = 10000;
      const requests = Array.from({ length: 5 }).map(() => 
        request(app.getHttpServer())
          .post(`${baseUrl}/wallet/fund`)
          .set('Authorization', `Bearer ${jwtToken}`)
          .set('x-idempotency-key', uuidv4())
          .send({ currency: 'NGN', amount })
      );

      const responses = await Promise.all(requests);
      responses.forEach(res => expect(res.status).toBe(200));

      const walletRes = await request(app.getHttpServer())
        .get(`${baseUrl}/wallet`)
        .set('Authorization', `Bearer ${jwtToken}`);
      
      const ngnBalance = walletRes.body.data.balances.find((b: any) => b.currency === 'NGN');
      expect(Number(ngnBalance.amountSubunits)).toBe(550000);
    });

    it('/api/v1/wallet/convert (POST) - Double-Entry Check', async () => {
      const idempotencyKey = uuidv4();
      const payload = { fromCurrency: 'NGN', toCurrency: 'USD', amount: 200000 };

      const res = await request(app.getHttpServer())
        .post(`${baseUrl}/wallet/convert`)
        .set('Authorization', `Bearer ${jwtToken}`)
        .set('x-idempotency-key', idempotencyKey)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(TransactionStatus.SUCCESS);
      expect(res.body.data.journal.entries).toHaveLength(2);
      
      const debit = res.body.data.journal.entries.find((e: any) => e.type === 'DEBIT');
      const credit = res.body.data.journal.entries.find((e: any) => e.type === 'CREDIT');

      expect(debit.currency).toBe('NGN');
      expect(Number(debit.amountSubunits)).toBe(200000);
      expect(credit.currency).toBe('USD');
      expect(Number(credit.amountSubunits)).toBe(120);
    });

    it('Concurrency Check: Parallel Conversions', async () => {
      const amount = 100000;
      const requests = Array.from({ length: 3 }).map(() => 
        request(app.getHttpServer())
          .post(`${baseUrl}/wallet/convert`)
          .set('Authorization', `Bearer ${jwtToken}`)
          .set('x-idempotency-key', uuidv4())
          .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount })
      );

      const responses = await Promise.all(requests);
      responses.forEach(res => expect(res.status).toBe(200));

      const failRes = await request(app.getHttpServer())
        .post(`${baseUrl}/wallet/convert`)
        .set('Authorization', `Bearer ${jwtToken}`)
        .set('x-idempotency-key', uuidv4())
        .send({ fromCurrency: 'NGN', toCurrency: 'USD', amount });

      expect(failRes.status).toBe(400);
      // Data might contain actual error message or structure
      expect(JSON.stringify(failRes.body)).toContain('Insufficient NGN balance');
    });

    it('/api/v1/transactions (GET) - History & Pagination', async () => {
      const res = await request(app.getHttpServer())
        .get(`${baseUrl}/transactions?limit=5`)
        .set('Authorization', `Bearer ${jwtToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(5);
      expect(res.body.data.hasNextPage).toBe(true);
      expect(res.body.data.nextCursor).toBeDefined();
    });
  });
});
