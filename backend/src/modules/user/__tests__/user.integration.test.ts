import request from 'supertest';
import app from '../../../app';
import { userService } from '../user.service';

jest.mock('../user.service');

// Integration tests mocking the service layer to test the Controller, Routes, Validators, and Multer
describe('User Endpoints (Integration Mocks)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/users/:username', () => {
    it('should return 200 with public profile', async () => {
      (userService.getPublicProfile as jest.Mock).mockResolvedValue({
        id: '123', username: 'testuser'
      });

      const response = await request(app).get('/api/v1/users/testuser');

      expect(response.status).toBe(200);
      expect(response.body.data.profile.username).toBe('testuser');
    });
  });

  describe('PATCH /api/v1/users/me', () => {
    it('should fail if unauthenticated', async () => {
      const response = await request(app)
        .patch('/api/v1/users/me')
        .send({ name: 'New Name' });

      expect(response.status).toBe(401);
    });

    // In a full e2e context, we would generate a valid token. 
    // Here we ensure middleware blocks unauthenticated requests.
  });

  describe('GET /api/v1/users/search', () => {
    it('should return 400 if query is missing', async () => {
      const response = await request(app).get('/api/v1/users/search');
      expect(response.status).toBe(400);
    });

    it('should call search and return 200', async () => {
      (userService.search as jest.Mock).mockResolvedValue([{ id: '123', username: 'john' }]);

      const response = await request(app).get('/api/v1/users/search?q=john');
      expect(response.status).toBe(200);
      expect(response.body.data.users).toHaveLength(1);
    });
  });
});
