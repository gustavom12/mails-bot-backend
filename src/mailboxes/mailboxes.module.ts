import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Mailbox, MailboxSchema } from './schemas/mailbox.schema';
import { MailboxesService } from './mailboxes.service';
import { MailboxesController } from './mailboxes.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Mailbox.name, schema: MailboxSchema }]),
  ],
  controllers: [MailboxesController],
  providers: [MailboxesService],
  exports: [MongooseModule, MailboxesService],
})
export class MailboxesModule {}
