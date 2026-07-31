import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Hotel, HotelSchema } from './schemas/hotel.schema';
import { Mailbox, MailboxSchema } from '../mailboxes/schemas/mailbox.schema';
import { HotelsService } from './hotels.service';
import { HotelsController } from './hotels.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Hotel.name, schema: HotelSchema },
      { name: Mailbox.name, schema: MailboxSchema },
    ]),
  ],
  controllers: [HotelsController],
  providers: [HotelsService],
  exports: [MongooseModule, HotelsService],
})
export class HotelsModule {}
