import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SigninDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'User email address',
  })
  @IsEmail({}, { message: 'Invalid credentials' })
  @IsNotEmpty({ message: 'Invalid credentials' })
  email!: string;

  @ApiProperty({
    example: 'StrongPassword123!',
    description: 'User password',
  })
  @IsString({ message: 'Invalid credentials' })
  @IsNotEmpty({ message: 'Invalid credentials' })
  password!: string;
}
