import request from 'supertest';
import app from '../../../app';
import { mediaService } from '../media.service';
import { tokensService } from '../../auth/tokens.service';

// Integration tests mock the service layer to exercise Routes, Multer, Validators,
// requireAuth and the response envelope.
jest.mock('../media.service');

const token = tokensService.generateAccessToken({ userId: 'user-1', role: 'USER' });
const authHeader = `Bearer ${token}`;
const pngBuffer = Buffer.from('fake-png-bytes');

describe('Media Endpoints (Integration Mocks)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/media/upload', () => {
    it('returns 401 without authentication', async () => {
      const response = await request(app)
        .post('/api/v1/media/upload')
        .attach('file', pngBuffer, 'pic.png');

      expect(response.status).toBe(401);
    });

    it('returns 400 NO_FILE when the multipart request omits the file', async () => {
      const response = await request(app)
        .post('/api/v1/media/upload')
        .set('Authorization', authHeader)
        .field('context', 'generic'); // multipart body present, but no file part

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('NO_FILE');
      expect(mediaService.uploadImage).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR for an invalid context field', async () => {
      const response = await request(app)
        .post('/api/v1/media/upload')
        .set('Authorization', authHeader)
        .field('context', 'not-a-real-context')
        .attach('file', pngBuffer, 'pic.png');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(mediaService.uploadImage).not.toHaveBeenCalled();
    });

    it('returns 201 with the standard envelope on success', async () => {
      (mediaService.uploadImage as jest.Mock).mockResolvedValue({
        id: 'm1',
        secureUrl: '/uploads/media/1-pic.png',
      });

      const response = await request(app)
        .post('/api/v1/media/upload')
        .set('Authorization', authHeader)
        .field('context', 'generic')
        .attach('file', pngBuffer, 'pic.png');

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.media.id).toBe('m1');
      expect(response.body.meta.message).toMatch(/uploaded/i);
      expect(mediaService.uploadImage).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/v1/media/:id', () => {
    it('returns 200 with the media for the authenticated owner', async () => {
      (mediaService.getMedia as jest.Mock).mockResolvedValue({ id: 'm1', secureUrl: '/uploads/x.png' });

      const response = await request(app).get('/api/v1/media/m1').set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.data.media.id).toBe('m1');
      expect(mediaService.getMedia).toHaveBeenCalledWith('m1', 'user-1');
    });

    it('returns 401 without a token', async () => {
      const response = await request(app).get('/api/v1/media/m1');
      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/media/:id', () => {
    it('returns 200 and delegates to the service', async () => {
      (mediaService.deleteMedia as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app).delete('/api/v1/media/m1').set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mediaService.deleteMedia).toHaveBeenCalledWith('m1', 'user-1');
    });
  });
});
