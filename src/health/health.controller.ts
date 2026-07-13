import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ConnectionStates } from 'mongoose';
import { Public } from '../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Public()
  @Get()
  check() {
    const dbStatus =
      this.connection.readyState === ConnectionStates.connected ? 'connected' : 'disconnected';

    return {
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      db: dbStatus,
      timestamp: new Date().toISOString(),
    };
  }
}
