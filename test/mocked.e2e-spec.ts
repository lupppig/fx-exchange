import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '@nestjs-modules/ioredis';
import { BullModule } from '@nestjs/bullmq';
import { ClientsModule } from '@nestjs/microservices';

describe('Mocked App (E2E)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
    .overrideModule(TypeOrmModule)
    .useModule(TypeOrmModule.forRoot({
      type: 'sqlite',
      database: ':memory:',
      autoLoadEntities: true,
      synchronize: true,
    }))
    .overrideModule(RedisModule)
    .useModule({ module: class MockRedisModule {}, providers: [] })
    .overrideModule(BullModule)
    .useModule({ module: class MockBullModule {}, providers: [] })
    .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should initialize with all mocks', () => {
    expect(app).toBeDefined();
  });
});
