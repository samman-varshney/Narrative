import EventEmitter from 'events';

class EventBus extends EventEmitter {}

export const eventBus = new EventBus();

// Strongly typed event names
export const EVENTS = {
  USER_REGISTERED: 'USER_REGISTERED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  EMAIL_VERIFICATION_REQUESTED: 'EMAIL_VERIFICATION_REQUESTED',
};
