import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import * as cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(cookieParser());
  app.setGlobalPrefix('api');

  const isDev = process.env.NODE_ENV !== 'production';
  app.enableCors({
    origin: isDev
      ? (origin, callback) => callback(null, true) // allow all origins in dev
      : process.env.FRONTEND_URL,
    credentials: true,
  });
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`🚀 API running on http://localhost:${port}/api`);
}

bootstrap();
