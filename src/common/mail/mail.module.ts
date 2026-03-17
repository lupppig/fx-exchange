import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { MailProcessor } from './mail.processor.js';
import { MailService } from './mail.service.js';

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
