import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Conversation, ConversationSchema } from './schemas/conversation.schema';
import { Message, MessageSchema } from '../messages/schemas/message.schema';
import { Mailbox, MailboxSchema } from '../mailboxes/schemas/mailbox.schema';
import { Hotel, HotelSchema } from '../hotels/schemas/hotel.schema';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { ConversationFollowupService } from './conversation-followup.service';
import { ConversationStatesModule } from '../conversation-states/conversation-states.module';
import { AurinkoModule } from '../aurinko/aurinko.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Mailbox.name, schema: MailboxSchema },
      { name: Hotel.name, schema: HotelSchema },
    ]),
    ConversationStatesModule,
    AurinkoModule,
    AiModule,
  ],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationFollowupService],
  exports: [MongooseModule, ConversationsService],
})
export class ConversationsModule {}
