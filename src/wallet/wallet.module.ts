import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WalletService } from './wallet.service.js';
import { WalletController } from './wallet.controller.js';
import { Wallet } from './entities/wallet.entity.js';
import { Balance } from './entities/balance.entity.js';
import { AuthMiddleware } from '../auth/middleware/auth.middleware.js';
import { FxModule } from '../fx/fx.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Wallet, Balance]),
    FxModule,
    TransactionsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(WalletController);
  }
}
