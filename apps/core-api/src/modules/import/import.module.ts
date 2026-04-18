import { Module } from '@nestjs/common';
import { ImportService } from './import.service.js';

@Module({
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
