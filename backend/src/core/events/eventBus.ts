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

  // Blog — payloads:
  //  BLOG_CREATED       { blogId, authorId, slug }
  //  BLOG_UPDATED       { blogId, authorId }
  //  BLOG_PUBLISHED     { blogId, authorId, slug, publishedAt }
  //  BLOG_UNPUBLISHED   { blogId, authorId }
  //  BLOG_ARCHIVED      { blogId, authorId }
  //  BLOG_RESTORED      { blogId, authorId, status }
  //  BLOG_DELETED       { blogId, authorId }
  //  BLOG_COVER_UPDATED { blogId, authorId, coverImage }
  BLOG_CREATED: 'BLOG_CREATED',
  BLOG_UPDATED: 'BLOG_UPDATED',
  BLOG_PUBLISHED: 'BLOG_PUBLISHED',
  BLOG_UNPUBLISHED: 'BLOG_UNPUBLISHED',
  BLOG_ARCHIVED: 'BLOG_ARCHIVED',
  BLOG_RESTORED: 'BLOG_RESTORED',
  BLOG_DELETED: 'BLOG_DELETED',
  BLOG_COVER_UPDATED: 'BLOG_COVER_UPDATED',

  // Comment — payloads:
  //  COMMENT_CREATED  { commentId, blogId, authorId, parentId }
  //  COMMENT_REPLIED  { commentId, blogId, authorId, parentId, parentAuthorId }
  //  COMMENT_UPDATED  { commentId, blogId, authorId }
  //  COMMENT_DELETED  { commentId, blogId, authorId }
  //  COMMENT_RESTORED { commentId, blogId, authorId }
  //  COMMENT_HIDDEN   { commentId, blogId, authorId }
  COMMENT_CREATED: 'COMMENT_CREATED',
  COMMENT_REPLIED: 'COMMENT_REPLIED',
  COMMENT_UPDATED: 'COMMENT_UPDATED',
  COMMENT_DELETED: 'COMMENT_DELETED',
  COMMENT_RESTORED: 'COMMENT_RESTORED',
  COMMENT_HIDDEN: 'COMMENT_HIDDEN',

  // Bookmark — payloads:
  //  BLOG_BOOKMARKED   { blogId, userId }
  //  BLOG_UNBOOKMARKED { blogId, userId }
  BLOG_BOOKMARKED: 'BLOG_BOOKMARKED',
  BLOG_UNBOOKMARKED: 'BLOG_UNBOOKMARKED',
};
