import { Controller, Post, Get, Req, Res, UseGuards, Body, HttpCode } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { LoginSchema } from './dto/login.dto';
import { UserDocument } from '../users/schemas/user.schema';

interface RequestWithUser extends Request {
  user: UserDocument;
}

/** Cross-origin (Vercel → Railway) requires SameSite=None + Secure in production. */
function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(200)
  login(
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    LoginSchema.parse(body);

    const { access_token } = this.authService.login(req.user);

    res.cookie('access_token', access_token, cookieOptions());

    return { message: 'Sesión iniciada', user: this.authService.getProfile(req.user) };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: RequestWithUser) {
    return this.authService.getProfile(req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('access_token', cookieOptions());
    return { message: 'Sesión cerrada' };
  }
}
