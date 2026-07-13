import EventEmitter from 'events';

class EventBus extends EventEmitter {}

export const eventBus = new EventBus();

// Strongly typed event names
export const EVENTS = {
  USER_REGISTERED: 'USER_REGISTERED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  EMAIL_VERIFICATION_REQUESTED: 'EMAIL_VERIFICATION_REQUESTED',
  USER_PROFILE_UPDATED: 'USER_PROFILE_UPDATED',
  USER_AVATAR_UPDATED: 'USER_AVATAR_UPDATED',
  USER_SETTINGS_UPDATED: 'USER_SETTINGS_UPDATED',
  USER_DELETED: 'USER_DELETED',

  // Media — payloads:
  //  MEDIA_UPLOADED { mediaId, userId, secureUrl }
  //  MEDIA_REPLACED { mediaId, userId, secureUrl, oldPublicId }
  //  MEDIA_DELETED  { mediaId, userId }
  MEDIA_UPLOADED: 'MEDIA_UPLOADED',
  MEDIA_REPLACED: 'MEDIA_REPLACED',
  MEDIA_DELETED: 'MEDIA_DELETED',

  // Follow — payloads:
  //  USER_FOLLOWED   { followerId, followingId }
  //  USER_UNFOLLOWED { followerId, followingId }
  USER_FOLLOWED: 'USER_FOLLOWED',
  USER_UNFOLLOWED: 'USER_UNFOLLOWED',
};
