import { authService } from '../auth.service';
import { userRepository } from '../../user/user.repository';
import { userService } from '../../user/user.service';
import { passwordService } from '../password.service';
import { sessionService } from '../session.service';
import { tokensService } from '../tokens.service';
import { accountStatusService } from '../accountStatus.service';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { AppError } from '../../../core/exceptions/AppError';

// Mock dependencies
jest.mock('../../user/user.repository');
jest.mock('../../user/user.service');
jest.mock('../password.service');
jest.mock('../session.service');
jest.mock('../tokens.service');
jest.mock('../accountStatus.service');
jest.mock('../../../core/events/eventBus');

describe('AuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    const mockInput = {
      email: 'test@example.com',
      username: 'testuser',
      password: 'Password123',
      name: 'Test User'
    };

    it('should register a new user successfully', async () => {
      (userRepository.findByEmail as jest.Mock).mockResolvedValue(null);
      (userRepository.findByUsername as jest.Mock).mockResolvedValue(null);
      (passwordService.hash as jest.Mock).mockResolvedValue('hashedPassword');
      
      const mockCreatedUser = { id: '123', ...mockInput, passwordHash: 'hashedPassword', role: 'USER' };
      (userRepository.create as jest.Mock).mockResolvedValue(mockCreatedUser);

      const result = await authService.register(mockInput);

      expect(userRepository.create).toHaveBeenCalledWith({
        email: mockInput.email,
        username: mockInput.username,
        name: mockInput.name,
        passwordHash: 'hashedPassword',
      });
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.USER_REGISTERED, { userId: '123', email: mockInput.email });
      expect(result).not.toHaveProperty('passwordHash');
      expect(result.email).toBe(mockInput.email);
    });

    it('should throw an error if email exists', async () => {
      (userRepository.findByEmail as jest.Mock).mockResolvedValue({ id: '123' });
      
      await expect(authService.register(mockInput)).rejects.toThrow(AppError);
      await expect(authService.register(mockInput)).rejects.toThrow('Email is already registered');
    });
  });

  describe('login', () => {
    const mockInput = { email: 'test@example.com', password: 'Password123' };

    it('should login successfully and return tokens', async () => {
      const mockUser = { id: '123', email: mockInput.email, passwordHash: 'hashed', role: 'USER', status: 'ACTIVE' };
      
      (userRepository.findByEmail as jest.Mock).mockResolvedValue(mockUser);
      (passwordService.verify as jest.Mock).mockResolvedValue(true);
      (tokensService.generateAccessToken as jest.Mock).mockReturnValue('access_token');
      (tokensService.generateRefreshToken as jest.Mock).mockReturnValue('refresh_token');
      (sessionService.createSession as jest.Mock).mockResolvedValue(true);

      const result = await authService.login(mockInput, { ipAddress: '127.0.0.1' });

      expect(result).toHaveProperty('accessToken', 'access_token');
      expect(result).toHaveProperty('refreshToken', 'refresh_token');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(sessionService.createSession).toHaveBeenCalledWith('123', 'refresh_token', { ipAddress: '127.0.0.1' });
    });

    it('should throw error for invalid password', async () => {
      const mockUser = { id: '123', email: mockInput.email, passwordHash: 'hashed', role: 'USER', status: 'ACTIVE' };
      (userRepository.findByEmail as jest.Mock).mockResolvedValue(mockUser);
      (passwordService.verify as jest.Mock).mockResolvedValue(false);

      await expect(authService.login(mockInput)).rejects.toThrow('Invalid email or password');
    });

    it('does not reactivate an ACTIVE account', async () => {
      const mockUser = { id: '123', email: mockInput.email, passwordHash: 'hashed', role: 'USER', status: 'ACTIVE' };
      (userRepository.findByEmail as jest.Mock).mockResolvedValue(mockUser);
      (passwordService.verify as jest.Mock).mockResolvedValue(true);

      const result = await authService.login(mockInput);

      expect(userService.reactivate).not.toHaveBeenCalled();
      expect(result.reactivated).toBe(false);
    });
  });

  describe('login, deactivated account', () => {
    const mockInput = { email: 'test@example.com', password: 'Password123' };
    const deactivatedUser = () => ({
      id: '123',
      email: mockInput.email,
      passwordHash: 'hashed',
      role: 'USER',
      status: 'DEACTIVATED',
      deactivatedAt: new Date('2026-01-01'),
    });

    beforeEach(() => {
      (tokensService.generateAccessToken as jest.Mock).mockReturnValue('access_token');
      (tokensService.generateRefreshToken as jest.Mock).mockReturnValue('refresh_token');
      (sessionService.createSession as jest.Mock).mockResolvedValue(true);
    });

    it('reactivates on a valid password and issues tokens', async () => {
      (userRepository.findByEmail as jest.Mock).mockResolvedValue(deactivatedUser());
      (passwordService.verify as jest.Mock).mockResolvedValue(true);
      (userService.reactivate as jest.Mock).mockResolvedValue(true);

      const result = await authService.login(mockInput);

      expect(userService.reactivate).toHaveBeenCalledWith('123');
      expect(result.reactivated).toBe(true);
      expect(result.accessToken).toBe('access_token');
      // The returned user must not still describe itself as deactivated — the
      // client renders straight from this.
      expect(result.user.status).toBe('ACTIVE');
      expect(result.user.deactivatedAt).toBeNull();
    });

    /**
     * The window this closes: deactivation primed the status cache to
     * DEACTIVATED with a 60s TTL, and `emit` is queue-backed, so relying on the
     * USER_REACTIVATED subscriber would hand back tokens that `requireActiveAccount`
     * rejects until the worker catches up.
     */
    it('primes the account status cache synchronously, not via the event bus', async () => {
      (userRepository.findByEmail as jest.Mock).mockResolvedValue(deactivatedUser());
      (passwordService.verify as jest.Mock).mockResolvedValue(true);
      (userService.reactivate as jest.Mock).mockResolvedValue(true);

      await authService.login(mockInput);

      expect(accountStatusService.prime).toHaveBeenCalledWith('123', 'ACTIVE');
    });

    /**
     * Reactivation sits BELOW the password check. Otherwise anyone who knows an
     * email address could pull a hidden account back into public view.
     */
    it('does not reactivate when the password is wrong', async () => {
      (userRepository.findByEmail as jest.Mock).mockResolvedValue(deactivatedUser());
      (passwordService.verify as jest.Mock).mockResolvedValue(false);

      await expect(authService.login(mockInput)).rejects.toThrow('Invalid email or password');
      expect(userService.reactivate).not.toHaveBeenCalled();
      expect(accountStatusService.prime).not.toHaveBeenCalled();
    });

    it('leaves a SUSPENDED account suspended — login is not a way out of one', async () => {
      (userRepository.findByEmail as jest.Mock).mockResolvedValue({
        ...deactivatedUser(),
        status: 'SUSPENDED',
      });
      (passwordService.verify as jest.Mock).mockResolvedValue(true);

      await expect(authService.login(mockInput)).rejects.toThrow('Your account has been suspended');
      expect(userService.reactivate).not.toHaveBeenCalled();
    });

    it('still refuses a DELETED account without reactivating it', async () => {
      (userRepository.findByEmail as jest.Mock).mockResolvedValue({
        ...deactivatedUser(),
        status: 'DELETED',
      });

      await expect(authService.login(mockInput)).rejects.toThrow('Invalid email or password');
      expect(userService.reactivate).not.toHaveBeenCalled();
    });
  });

  describe('refreshTokens', () => {
    it('should throw error if token is invalid or session not found', async () => {
      (tokensService.verifyRefreshToken as jest.Mock).mockReturnValue({ userId: '123' });
      (sessionService.validateSession as jest.Mock).mockResolvedValue(null);

      await expect(authService.refreshTokens('old_token')).rejects.toThrow('Refresh token revoked or invalid');
    });
  });
});
