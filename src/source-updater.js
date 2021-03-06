/**
 * @file source-updater.js
 */
import videojs from 'video.js';
import { printableRange } from './ranges';
import logger from './util/logger';
import noop from './util/noop';

/**
 * A queue of callbacks to be serialized and applied when a
 * MediaSource and its associated SourceBuffers are not in the
 * updating state. It is used by the segment loader to update the
 * underlying SourceBuffers when new data is loaded, for instance.
 *
 * @class SourceUpdater
 * @param {MediaSource} mediaSource the MediaSource to create the
 * SourceBuffer from
 * @param {String} mimeType the desired MIME type of the underlying
 * SourceBuffer
 * @param {Object} sourceBufferEmitter an event emitter that fires when a source buffer is
 * added to the media source
 */
export default class SourceUpdater {
  constructor(mediaSource, mimeType, type, sourceBufferEmitter) {
    this.callbacks_ = [];
    this.pendingCallback_ = null;
    this.timestampOffset_ = 0;
    this.mediaSource = mediaSource;
    this.processedAppend_ = false;
    this.type_ = type;
    this.mimeType_ = mimeType;
    this.logger_ = logger(`SourceUpdater[${type}][${mimeType}]`);

    if (mediaSource.readyState === 'closed') {
      mediaSource.addEventListener(
        'sourceopen', this.createSourceBuffer_.bind(this, mimeType, sourceBufferEmitter));
    } else {
      this.createSourceBuffer_(mimeType, sourceBufferEmitter);
    }
  }

  createSourceBuffer_(mimeType, sourceBufferEmitter) {
    this.sourceBuffer_ = this.mediaSource.addSourceBuffer(mimeType);

    this.logger_('created SourceBuffer');

    if (sourceBufferEmitter) {
      sourceBufferEmitter.trigger('sourcebufferadded');

      if (this.mediaSource.sourceBuffers.length < 2) {
        // There's another source buffer we must wait for before we can start updating
        // our own (or else we can get into a bad state, i.e., appending video/audio data
        // before the other video/audio source buffer is available and leading to a video
        // or audio only buffer).
        sourceBufferEmitter.on('sourcebufferadded', () => {
          this.start_();
        });
        return;
      }
    }

    this.start_();
  }

  start_() {
    this.started_ = true;

    // run completion handlers and process callbacks as updateend
    // events fire
    this.onUpdateendCallback_ = () => {
      let pendingCallback = this.pendingCallback_;

      this.pendingCallback_ = null;

      this.logger_(`buffered [${printableRange(this.buffered())}]`);

      if (pendingCallback) {
        pendingCallback();
      }

      this.runCallback_();
    };

    this.sourceBuffer_.addEventListener('updateend', this.onUpdateendCallback_);

    this.runCallback_();
  }

  /**
   * Aborts the current segment and resets the segment parser.
   *
   * @param {Function} done function to call when done
   * @see http://w3c.github.io/media-source/#widl-SourceBuffer-abort-void
   */
  abort(done) {
    if (this.processedAppend_) {
      this.queueCallback_(() => {
        this.sourceBuffer_.abort();
      }, done);
    }
  }

  /**
   * Queue an update to append an ArrayBuffer.
   *
   * @param {ArrayBuffer} bytes
   * @param {Function} done the function to call when done
   * @see http://www.w3.org/TR/media-source/#widl-SourceBuffer-appendBuffer-void-ArrayBuffer-data
   */
  appendBuffer(bytes, done) {
    this.processedAppend_ = true;
    this.queueCallback_(() => {
      this.sourceBuffer_.appendBuffer(bytes);
    }, done);
  }

  /**
   * Indicates what TimeRanges are buffered in the managed SourceBuffer.
   *
   * @see http://www.w3.org/TR/media-source/#widl-SourceBuffer-buffered
   */
  buffered() {
    if (!this.sourceBuffer_) {
      return videojs.createTimeRanges();
    }
    return this.sourceBuffer_.buffered;
  }

  /**
   * Queue an update to remove a time range from the buffer.
   *
   * @param {Number} start where to start the removal
   * @param {Number} end where to end the removal
   * @param {Function} [done=noop] optional callback to be executed when the remove
   * operation is complete
   * @see http://www.w3.org/TR/media-source/#widl-SourceBuffer-remove-void-double-start-unrestricted-double-end
   */
  remove(start, end, done = noop) {
    if (this.processedAppend_) {
      this.queueCallback_(() => {
        this.logger_(`remove [${start} => ${end}]`);
        this.sourceBuffer_.remove(start, end);
      }, done);
    }
  }

  /**
   * Whether the underlying sourceBuffer is updating or not
   *
   * @return {Boolean} the updating status of the SourceBuffer
   */
  updating() {
    return !this.sourceBuffer_ || this.sourceBuffer_.updating || this.pendingCallback_;
  }

  /**
   * Set/get the timestampoffset on the SourceBuffer
   *
   * @return {Number} the timestamp offset
   */
  timestampOffset(offset) {
    if (typeof offset !== 'undefined') {
      this.queueCallback_(() => {
        this.sourceBuffer_.timestampOffset = offset;
      });
      this.timestampOffset_ = offset;
    }
    return this.timestampOffset_;
  }

  /**
   * Queue a callback to run
   */
  queueCallback_(callback, done) {
    this.callbacks_.push([callback.bind(this), done]);
    this.runCallback_();
  }

  /**
   * Run a queued callback
   */
  runCallback_() {
    let callbacks;

    if (!this.updating() &&
        this.callbacks_.length &&
        this.started_) {
      callbacks = this.callbacks_.shift();
      this.pendingCallback_ = callbacks[1];
      callbacks[0]();
    }
  }

  /**
   * dispose of the source updater and the underlying sourceBuffer
   */
  dispose() {
    this.sourceBuffer_.removeEventListener('updateend', this.onUpdateendCallback_);
    if (this.sourceBuffer_ && this.mediaSource.readyState === 'open') {
      this.sourceBuffer_.abort();
    }
  }
}
