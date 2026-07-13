import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Mailbox, MailboxSchema } from './schemas/mailbox.schema';
import { MailboxesService } from './mailboxes.service';
import { MailboxesController } from './mailboxes.controller';
import { HotelsModule } from '../hotels/hotels.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Mailbox.name, schema: MailboxSchema }]),
    HotelsModule,
  ],
  controllers: [MailboxesController],
  providers: [MailboxesService],
  exports: [MongooseModule, MailboxesService],
})
export class MailboxesModule {}
