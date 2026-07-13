import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { Connection } from 'mongoose';
import { HealthModule } from './health/health.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { HotelsModule } from './hotels/hotels.module';
import { MailboxesModule } from './mailboxes/mailboxes.module';
import { EncryptionModule } from './common/crypto/encryption.module';
import { MicrosoftModule } from './microsoft/microsoft.module';
import { AurinkoModule } from './aurinko/aurinko.module';
import { MailModule } from './mail/mail.module';
import { ConversationStatesModule } from './conversation-states/conversation-states.module';
import { ConversationsModule } from './conversations/conversations.module';
import { TemplatesModule } from './templates/templates.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
        connectionFactory: (connection: Connection) => {
          if (connection.readyState === 1) {
            console.log('✅ MongoDB connected');
          }
          connection.on('error', (err: Error) => {
            console.error('❌ MongoDB connection error:', err.message);
          });
          return connection;
        },
      }),
      inject: [ConfigService],
    }),
    EncryptionModule,
    HealthModule,
    TenantsModule,
    UsersModule,
    AuthModule,
    HotelsModule,
    MailboxesModule,
    MicrosoftModule,
    AurinkoModule,
    MailModule,
    ConversationStatesModule,
    ConversationsModule,
    TemplatesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
