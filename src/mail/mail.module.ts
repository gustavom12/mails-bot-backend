import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Conversation, ConversationSchema } from '../conversations/schemas/conversation.schema';
import { Message, MessageSchema } from '../messages/schemas/message.schema';
import { MailSyncService } from './mail-sync.service';
import { MailController } from './mail.controller';
import { WebhookController } from '../microsoft/webhook.controller';
import { MicrosoftModule } from '../microsoft/microsoft.module';
import { MailboxesModule } from '../mailboxes/mailboxes.module';
import { ConversationStatesModule } from '../conversation-states/conversation-states.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
    MicrosoftModule,
    MailboxesModule,
    ConversationStatesModule,
  ],
  controllers: [MailController, WebhookController],
  providers: [MailSyncService],
  exports: [MailSyncService, MongooseModule],
})
export class MailModule {}
