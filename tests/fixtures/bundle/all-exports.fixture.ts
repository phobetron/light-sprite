import * as library from 'light-sprite';

// Namespace escape exercises delivery of the complete public runtime API.
(globalThis as typeof globalThis & { lightSprite?: typeof library }).lightSprite = library;
