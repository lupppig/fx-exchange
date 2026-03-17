import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Processor('mail')
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    super();
    this.transporter = nodemailer.createTransport({
      host: this.configService.get('MAIL_HOST'),
      port: this.configService.get('MAIL_PORT'),
      secure: false, // port 25
      auth: {
        user: this.configService.get('MAIL_USER'),
        pass: this.configService.get('MAIL_PASS'),
      },
    });
  }

  async process(job: Job<any>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);
    switch (job.name) {
      case 'send-otp':
        return this.sendOtp(job.data);
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  private async sendOtp(data: { email: string; otp: string }) {
    const { email, otp } = data;
    this.logger.log(`Attempting to send OTP to ${email} via ${this.configService.get('MAIL_HOST')}:${this.configService.get('MAIL_PORT')}`);
    try {
      await this.transporter.sendMail({
        from: this.configService.get('MAIL_FROM'),
        to: email,
        subject: 'Your FX Exchange OTP',
        text: `Your verification code is: ${otp}. It expires in 10 minutes.`,
        html: `<p>Your verification code is: <b>${otp}</b>. It expires in 10 minutes.</p>`,
      });
      this.logger.log(`OTP sent successfully to ${email}`);
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to send OTP to ${email}`, error.stack);
      } else {
        this.logger.error(`Failed to send OTP to ${email}`, String(error));
      }
      throw error;
    }
  }
}
