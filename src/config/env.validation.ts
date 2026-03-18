import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'provision')
    .default('development'),
  PORT: Joi.number().default(3000),
  APP_URL: Joi.string().uri().optional(),
  DATABASE_URL: Joi.string().required(),
  DB_SYNC: Joi.boolean().default(false),
  DB_POOL_MAX: Joi.number().default(20),
  DB_POOL_MIN: Joi.number().default(5),
  REDIS_URL: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  GLOBAL_PREFIX: Joi.string().default('api'),
  RATE_LIMIT_TTL: Joi.number().default(60),
  RATE_LIMIT_LIMIT: Joi.number().default(10),
  MAIL_HOST: Joi.string().required(),
  MAIL_PORT: Joi.number().required(),
  MAIL_USER: Joi.string().required(),
  MAIL_PASS: Joi.string().required(),
  MAIL_FROM: Joi.string().required(),
  EXCHANGE_RATE_API_KEY: Joi.string().required(),
  FX_RETRY_MAX: Joi.number().integer().min(0).max(10).default(3),
  FX_RETRY_BASE_DELAY_MS: Joi.number().integer().min(100).max(10000).default(300),
  FX_REQUEST_TIMEOUT_MS: Joi.number().integer().min(1000).max(30000).default(5000),
});
