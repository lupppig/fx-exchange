import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('AuthFlow (e2e)', () => {
  let app: INestApplication;
  const testEmail = `e2e_${Date.now()}@example.com`;
  const plainPassword = 'StrongPassword123!';
  let jwtToken = '';

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('/api/v1/auth/register (POST)', () => {
    return request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: testEmail, password: plainPassword })
      .expect(202)
      .expect((res) => {
        expect(res.body.success).toBe(true);
      });
  });

  it('/api/v1/auth/signin (POST) - unverified', () => {
    return request(app.getHttpServer())
      .post('/api/v1/auth/signin')
      .send({ email: testEmail, password: plainPassword })
      .expect(400)
      .expect((res) => {
        expect(res.body.message).toBe('Please verify your email first');
      });
  });

  it('/api/v1/auth/verify (POST) - correct OTP should verify', async () => {
    // Read the user ID from the database
    const { DataSource } = require('typeorm');
    const { User } = require('../src/users/user.entity');
    const dataSource = app.get(DataSource);
    const user = await dataSource.getRepository(User).findOneBy({ email: testEmail });
    expect(user).toBeDefined();

    // The OTP keys use user.id, not email!
    const { getRedisConnectionToken } = require('@nestjs-modules/ioredis');
    const redis = app.get(getRedisConnectionToken('default'));
    const bcrypt = require('bcrypt');
    const knownOtp = '123456';
    const newHash = await bcrypt.hash(knownOtp, 10);
    
    // Set known OTP hash
    await redis.set(`otp:${user.id}`, newHash, 'EX', 600);
    await redis.set(`otp:attempts:${user.id}`, 0, 'EX', 900);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({ email: testEmail, otp: knownOtp });
    
    if (res.status !== 200) console.log('Verify Error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toBe('Email verified successfully');
  });

  it('/api/v1/auth/signin (POST) - verified success', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signin')
      .send({ email: testEmail, password: plainPassword });
      
    if (res.status !== 200) console.log('Signin Error:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toBeDefined();
    jwtToken = res.body.data.access_token;
  });
});
