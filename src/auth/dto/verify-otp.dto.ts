import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyOtpDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'The email address of the user',
  })
  @IsEmail({}, { message: 'Invalid OTP' })
  @IsNotEmpty({ message: 'Invalid OTP' })
  email!: string;

  @ApiProperty({
    example: '123456',
    description: 'The 6-digit OTP sent to the user email',
  })
  @IsString({ message: 'Invalid OTP' })
  @IsNotEmpty({ message: 'Invalid OTP' })
  @Length(6, 6, { message: 'Invalid OTP' })
  otp!: string;
}
