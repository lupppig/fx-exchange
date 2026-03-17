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

  // Since we don't have the OTP in this test environment without reading redis,
  // we'll explicitly update the DB in another test suite (wallet.e2e-spec.ts)
  // to get a valid token. This suite just ensures the endpoints are wired up.
});
