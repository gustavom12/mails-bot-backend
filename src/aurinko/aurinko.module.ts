import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AurinkoService } from './aurinko.service';
import { AurinkoSyncService } from './aurinko-sync.service';
import { AurinkoController } from './aurinko.controller';
import { AurinkoWebhookController } from './aurinko-webhook.controller';
import { MailboxesModule } from '../mailboxes/mailboxes.module';
import { EncryptionModule } from '../common/crypto/encryption.module';
import { ConversationStatesModule } from '../conversation-states/conversation-states.module';
import { AiModule } from '../ai/ai.module';
import { Conversation, ConversationSchema } from '../conversations/schemas/conversation.schema';
import { Message, MessageSchema } from '../messages/schemas/message.schema';
import { Mailbox, MailboxSchema } from '../mailboxes/schemas/mailbox.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Mailbox.name, schema: MailboxSchema },
    ]),
    MailboxesModule,
    EncryptionModule,
    ConversationStatesModule,
    AiModule,
  ],
  controllers: [AurinkoController, AurinkoWebhookController],
  providers: [AurinkoService, AurinkoSyncService],
  exports: [AurinkoService, AurinkoSyncService],
})
export class AurinkoModule {}
