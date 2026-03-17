import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { User } from '../src/users/user.entity';

describe('WalletFlow (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  
  const user1Email = `user1_${Date.now()}@test.com`;
  const user2Email = `user2_${Date.now()}@test.com`;
  const plainPassword = 'StrongPassword123!';
  
  let user1Token = '';
  let user2Token = '';
  let user1WalletId = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const { HttpAdapterHost } = require('@nestjs/core');
    const { AllExceptionsFilter } = require('../src/common/filters/http-exception.filter');
    const { TransformInterceptor } = require('../src/common/interceptors/transform.interceptor');

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new AllExceptionsFilter(httpAdapterHost));
    app.useGlobalInterceptors(new TransformInterceptor());

    await app.init();

    dataSource = app.get(DataSource);

    // Setup: Register two users
    const reg1 = await request(app.getHttpServer()).post('/api/v1/auth/register').send({ email: user1Email, password: plainPassword });
    if (reg1.status !== 202) throw new Error(`Reg1 failed: ${JSON.stringify(reg1.body)}`);
    
    const reg2 = await request(app.getHttpServer()).post('/api/v1/auth/register').send({ email: user2Email, password: plainPassword });
    if (reg2.status !== 202) throw new Error(`Reg2 failed: ${JSON.stringify(reg2.body)}`);

    // Manually verify them in DB
    await dataSource.createQueryBuilder().update(User).set({ isVerified: true }).where('email IN (:...emails)', { emails: [user1Email, user2Email] }).execute();

    // Get Tokens
    const signin1 = await request(app.getHttpServer()).post('/api/v1/auth/signin').send({ email: user1Email, password: plainPassword });
    if (signin1.status !== 200) throw new Error(`Signin1 failed: ${JSON.stringify(signin1.body)}`);
    user1Token = signin1.body.data.access_token;

    const signin2 = await request(app.getHttpServer()).post('/api/v1/auth/signin').send({ email: user2Email, password: plainPassword });
    if (signin2.status !== 200) throw new Error(`Signin2 failed: ${JSON.stringify(signin2.body)}`);
    user2Token = signin2.body.data.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('/api/v1/wallet (GET) - User 1 creates empty wallet', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${user1Token}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.walletId).toBeDefined();
    expect(res.body.data.balances.length).toBe(0);
    
    user1WalletId = res.body.data.walletId;
  });

  it('/api/v1/wallet/fund (POST) - IDOR Prevention (User 2 Cannot access User 1 wallet)', async () => {
    // Current design already prevents this because fund routes don't take a wallet ID in the body;
    // they derive it safely from the JWT token. Let's prove User 2 gets credit on their own wallet instead.
    const res = await request(app.getHttpServer())
      .post('/api/v1/wallet/fund')
      .set('Authorization', `Bearer ${user2Token}`)
      .set('x-idempotency-key', `user2-fund-${Date.now()}`)
      .send({ currency: 'NGN', amount: 5000 })
      .expect(200);

    expect(res.body.data.transaction.walletId).not.toBe(user1WalletId);
  });

  it('/api/v1/wallet/fund (POST) - Missing Idempotency Key', async () => {
    return request(app.getHttpServer())
      .post('/api/v1/wallet/fund')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({ currency: 'NGN', amount: 500 })
      .expect(400); // Bad Request expected
  });

  it('/api/v1/wallet/fund (POST) - Idempotent success', async () => {
    const idemKey = `idem-${Date.now()}`;
    
    // Call 1
    const res1 = await request(app.getHttpServer())
      .post('/api/v1/wallet/fund')
      .set('Authorization', `Bearer ${user1Token}`)
      .set('x-idempotency-key', idemKey)
      .send({ currency: 'USD', amount: 100 })
      .expect(200);

    expect(res1.body.data.message).toBe('Wallet funded successfully');
    expect(Number(res1.body.data.transaction.balanceAfter)).toBe(100);

    // Call 2 (Duplicate)
    const res2 = await request(app.getHttpServer())
      .post('/api/v1/wallet/fund')
      .set('Authorization', `Bearer ${user1Token}`)
      .set('x-idempotency-key', idemKey)
      .send({ currency: 'USD', amount: 100 })
      .expect(200);

    expect(res2.body.data.message).toBe('Transaction already processed');
    // Balance should remain 100, not 200
    expect(Number(res2.body.data.transaction.balanceAfter)).toBe(100);
  });

  it('/api/v1/wallet/fund (POST) - Concurrency edge case (Promise.all) - double spend prevention', async () => {
    // Attempt 5 simultaneous fund requests with DIFFERENT idempotency keys 
    // to simulate a burst of unique valid transactions (e.g. race condition).
    // In PostgreSQL SERIALIZABLE isolation, concurrent transactions conflicting on the same row 
    // will serialize properly, and some may wait or retry, resulting in a consistent sum.
    // However, since we are doing 5 parallel requests on the same wallet row, 
    // some might throw a PostgreSQL serialization failure (code 40001). 
    // Our goal is to ensure the final balance strictly matches the successful queries!
    
    // First, let's get the starting balance
    const walletBefore = await request(app.getHttpServer())
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${user1Token}`)
      .expect(200);
      
    const startBalanceEur = Number(walletBefore.body.data.balances.find((b: any) => b.currency === 'EUR')?.amount || 0);

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        request(app.getHttpServer())
          .post('/api/v1/wallet/fund')
          .set('Authorization', `Bearer ${user1Token}`)
          .set('x-idempotency-key', `idem-concurrent-eur-${Date.now()}-${i}`)
          .send({ currency: 'EUR', amount: 100 })
      );
    }
    
    const results = await Promise.all(promises);
    
    // Count successful 200 responses
    let successCount = 0;
    for (const res of results) {
      if (res.status === 200 && res.body.success === true) {
        successCount++;
      }
    }

    // Now check the final balance
    const walletAfter = await request(app.getHttpServer())
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${user1Token}`)
      .expect(200);

    const finalBalanceEur = Number(walletAfter.body.data.balances.find((b: any) => b.currency === 'EUR').amount);
    
    // The final balance should EXACTLY equal Start + (100 * Successful Transactions)
    // Serialization locks prevent dirty reads or race condition double credits.
    expect(finalBalanceEur).toBe(startBalanceEur + (100 * successCount));
  });
});
