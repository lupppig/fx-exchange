import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { MailProcessor } from './mail.processor';
import { MailService } from './mail.service';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'mail',
    }),
  ],
  providers: [MailProcessor, MailService],
  exports: [MailService, BullModule],
})
export class MailModule {}
