import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Hotel, HotelSchema } from './schemas/hotel.schema';
import { HotelsService } from './hotels.service';
import { HotelsController } from './hotels.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Hotel.name, schema: HotelSchema }])],
  controllers: [HotelsController],
  providers: [HotelsService],
  exports: [MongooseModule, HotelsService],
})
export class HotelsModule {}
