import { Module } from '@nestjs/common';
import { AssetController } from './asset.controller.js';
import { AssetService } from './asset.service.js';

@Module({
  controllers: [AssetController],
  providers: [AssetService],
  exports: [AssetService],
})
export class AssetModule {}
