import { Global, Module } from '@nestjs/common';
import { EmailConfigService } from './email.config.js';
import { EmailService } from './email.service.js';

@Global()
@Module({
  providers: [EmailConfigService, EmailService],
  exports: [EmailConfigService, EmailService],
})
export class EmailModule {}
