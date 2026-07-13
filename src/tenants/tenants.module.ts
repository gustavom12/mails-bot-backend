import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Tenant, TenantSchema } from './schemas/tenant.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Tenant.name, schema: TenantSchema }])],
  exports: [MongooseModule],
})
export class TenantsModule {}
