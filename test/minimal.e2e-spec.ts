import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';

describe('Minimal App (E2E)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }, 30000); // 30s timeout for init

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should initialize app', () => {
    expect(app).toBeDefined();
  });
});
