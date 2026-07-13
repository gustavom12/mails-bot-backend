import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ResponseTemplate, ResponseTemplateSchema } from './schemas/response-template.schema';
import { TemplatesService } from './templates.service';
import { TemplatesController } from './templates.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ResponseTemplate.name, schema: ResponseTemplateSchema }]),
  ],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [MongooseModule, TemplatesService],
})
export class TemplatesModule {}
