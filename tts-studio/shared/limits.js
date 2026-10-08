/**
 * What a lesson may be given. The one copy: the server enforces these and the page
 * shows them, so they are imported by both (server/, author/ and client/src/).
 * Nothing here may import from Node or the browser.
 */
export const MAX_NOTES = 60_000; // characters of notes sent to Claude, typed and from documents together
export const MAX_FILES = 12; // the API is stricter about image size past 20 images and PDFs
export const MAX_BYTES = 20 * 1024 * 1024; // all files together; a request to Claude may be 32 MB once encoded

export const TEXT_EXT = ['txt', 'md', 'markdown', 'text']; // read by the browser into the notes box
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'tif', 'tiff', 'bmp'];
export const DOC_EXT = ['docx', 'doc', 'rtf', 'odt'];

export const LESSON_MINUTES = [1, 2, 3, 5, 10, 15, 20, 30];
// From this length a lesson is written in chapters: an outline first, then each chapter on its own.
export const CHAPTERS_FROM = 10;
export const MAX_CHAPTERS = 8;
export const VIDEO_QUALITIES = ['default', 'low', 'medium', 'hd', '4k'];
