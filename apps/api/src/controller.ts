import { Body, Controller, Get, HttpException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { LiveSessionStateSchema, ResponseEvaluationRequestSchema } from '@liveops/live-contracts';
import { z } from 'zod';
import { LiveService } from './service.js';

function badRequest(error: unknown): never {
  const message = error instanceof Error ? error.message : '请求内容不符合要求';
  throw new HttpException({ code: 'INVALID_REQUEST', message }, 400);
}

@Controller()
export class AppController {
  constructor(private readonly live: LiveService) {}

  @Get('/health')
  health() {
    return this.live.health();
  }

  @Get('/bootstrap')
  bootstrap() {
    return this.live.bootstrap();
  }

  @Get('/config')
  getConfig() {
    return this.live.getConfig();
  }

  @Put('/config')
  async updateConfig(@Body() body: unknown) {
    try {
      return await this.live.updateConfig(body);
    } catch (error) {
      badRequest(error);
    }
  }

  @Get('/offers')
  listOffers() {
    return this.live.listOffers();
  }

  @Post('/offers')
  async saveOffer(@Body() body: unknown) {
    try {
      return await this.live.saveOffer(body);
    } catch (error) {
      badRequest(error);
    }
  }

  @Get('/knowledge')
  listKnowledge() {
    return this.live.listKnowledge();
  }

  @Post('/knowledge')
  async saveKnowledge(@Body() body: unknown) {
    try {
      return await this.live.saveKnowledge(body);
    } catch (error) {
      badRequest(error);
    }
  }

  @Post('/responses/evaluate')
  async evaluate(@Body() body: unknown) {
    try {
      return await this.live.evaluate(ResponseEvaluationRequestSchema.parse(body));
    } catch (error) {
      badRequest(error);
    }
  }

  @Post('/run-sheet/authorize')
  async authorizeRunSheet(@Body() body: unknown) {
    try {
      const parsed = z.object({ script: z.string().min(1).max(1000) }).parse(body);
      return await this.live.authorizeRunSheetScript(parsed.script);
    } catch (error) {
      badRequest(error);
    }
  }

  @Post('/runtime/hardware')
  async updateHardware(@Body() body: unknown) {
    try {
      return await this.live.updateHardware(z.object({
        cameraDeviceId: z.string().max(300).nullable().optional(),
        cameraLabel: z.string().max(300).nullable().optional(),
        cameraStreamActive: z.boolean().optional(),
        cameraFramingConfirmed: z.boolean().optional(),
        voiceReady: z.boolean().optional(),
        takeoverReady: z.boolean().optional(),
      }).parse(body));
    } catch (error) {
      badRequest(error);
    }
  }

  @Post('/evidence/files')
  async saveEvidenceFile(@Body() body: unknown) {
    try {
      const parsed = z.object({
        fileName: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(100),
        contentBase64: z.string().min(1).max(14_500_000),
        privacyConfirmed: z.literal(true),
      }).parse(body);
      return await this.live.saveEvidenceFile(parsed);
    } catch (error) {
      badRequest(error);
    }
  }

  @Get('/preflight')
  preflight() {
    return this.live.preflight();
  }

  @Post('/sessions')
  createSession() {
    return this.live.createSession();
  }

  @Get('/sessions/latest')
  latestSession() {
    return this.live.latestSession();
  }

  @Patch('/sessions/:id/transition')
  async transition(@Param('id') id: string, @Body() body: unknown) {
    try {
      const parsed = z.object({
        state: LiveSessionStateSchema,
        reason: z.string().max(300).nullable().default(null),
        externalStartConfirmed: z.boolean().default(false),
      }).parse(body);
      return await this.live.transition(id, parsed.state, parsed.reason, parsed.externalStartConfirmed);
    } catch (error) {
      badRequest(error);
    }
  }

  @Post('/sessions/:id/presence')
  presence(@Param('id') id: string) {
    return this.live.acknowledgePresence(id);
  }

  @Get('/sessions/:id/events')
  events(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.live.listEvents(id, Number(limit ?? 100));
  }

  @Post('/sessions/:id/events')
  addEvent(@Param('id') id: string, @Body() body: unknown) {
    try {
      return this.live.addEvent(id, z.object({
        type: z.enum(['OPERATOR_ACTION', 'CAMERA_STATUS', 'VOICE_STATUS', 'RISK_ALERT']),
        severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
        message: z.string().min(1).max(500),
        payload: z.record(z.string(), z.unknown()).default({}),
      }).parse(body));
    } catch (error) {
      badRequest(error);
    }
  }

  @Get('/orders')
  listOrders() {
    return this.live.listOrders();
  }

  @Post('/orders')
  async saveOrder(@Body() body: unknown) {
    try {
      return await this.live.saveOrder(body);
    } catch (error) {
      badRequest(error);
    }
  }

  @Get('/reports/cohort')
  report() {
    return this.live.cohortReport();
  }

  @Post('/exports/cohort')
  exportCohort() {
    return this.live.exportCohort();
  }

  @Get('/audit')
  audit(@Query('limit') limit?: string) {
    return this.live.audit(Number(limit ?? 100));
  }

  @Get('/backups')
  listBackups() {
    return this.live.listBackups();
  }

  @Post('/backups')
  async createBackup(@Body() body: unknown) {
    try {
      const label = body && typeof body === 'object' && typeof (body as Record<string, unknown>).label === 'string'
        ? String((body as Record<string, unknown>).label).slice(0, 80)
        : undefined;
      return await this.live.createBackup(label);
    } catch (error) {
      badRequest(error);
    }
  }

  @Get('/backups/:name/verify')
  async verifyBackup(@Param('name') name: string) {
    try {
      return await this.live.verifyBackup(name);
    } catch (error) {
      badRequest(error);
    }
  }

  @Post('/backups/:name/restore')
  async restoreBackup(@Param('name') name: string) {
    try {
      return await this.live.restoreBackup(name);
    } catch (error) {
      badRequest(error);
    }
  }
}
