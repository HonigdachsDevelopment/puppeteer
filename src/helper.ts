/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import Errors = require('./Errors');

import debug = require('debug');
const debugError = debug('puppeteer:error');
import fs = require('fs');
import util = require('util');

const {TimeoutError} = Errors;
// TODO: does Browserify take this happily?
const {promisify} = util;

const openAsync = promisify(fs.open);
const writeAsync = promisify(fs.write);
const closeAsync = promisify(fs.close);

function assert(value: unknown, message?: string): void {
  if (!value)
    throw new Error(message);
}

interface AnyClass {
  prototype: object;
}


class Helper {
  /**
   * @param {Function|string} fun
   * @param {!Array<*>} args
   * @return {string}
   */
  static evaluationString(fun: Function | string, ...args: unknown[]): string {
    if (Helper.isString(fun)) {
      assert(args.length === 0, 'Cannot evaluate a string with arguments');
      return fun;
    }

    function serializeArgument(arg: unknown): string {
      if (Object.is(arg, undefined))
        return 'undefined';
      return JSON.stringify(arg);
    }

    return `(${fun})(${args.map(serializeArgument).join(',')})`;
  }

  static getExceptionMessage(exceptionDetails: Protocol.Runtime.ExceptionDetails): string {
    if (exceptionDetails.exception)
      return exceptionDetails.exception.description || exceptionDetails.exception.value;
    let message = exceptionDetails.text;
    if (exceptionDetails.stackTrace) {
      for (const callframe of exceptionDetails.stackTrace.callFrames) {
        const location = callframe.url + ':' + callframe.lineNumber + ':' + callframe.columnNumber;
        const functionName = callframe.functionName || '<anonymous>';
        message += `\n    at ${functionName} (${location})`;
      }
    }
    return message;
  }

  static valueFromRemoteObject(remoteObject: Protocol.Runtime.RemoteObject): unknown {
    assert(!remoteObject.objectId, 'Cannot extract value when objectId is given');
    if (remoteObject.unserializableValue) {
      if (remoteObject.type === 'bigint' && typeof BigInt !== 'undefined')
        return BigInt(remoteObject.unserializableValue.replace('n', ''));
      switch (remoteObject.unserializableValue) {
        case '-0':
          return -0;
        case 'NaN':
          return NaN;
        case 'Infinity':
          return Infinity;
        case '-Infinity':
          return -Infinity;
        default:
          throw new Error('Unsupported unserializable value: ' + remoteObject.unserializableValue);
      }
    }
    return remoteObject.value;
  }

  static async releaseObject(client: Puppeteer.CDPSession, remoteObject: Protocol.Runtime.RemoteObject): Promise<void> {
    if (!remoteObject.objectId)
      return;
    await client.send('Runtime.releaseObject', {objectId: remoteObject.objectId}).catch(error => {
      // Exceptions might happen in case of a page been navigated or closed.
      // Swallow these since they are harmless and we don't leak anything in this case.
      debugError(error);
    });
  }

  static installAsyncStackHooks(classType: AnyClass): void {
    for (const methodName of Reflect.ownKeys(classType.prototype)) {
      const method = Reflect.get(classType.prototype, methodName);
      if (methodName === 'constructor' || typeof methodName !== 'string' || methodName.startsWith('_') || typeof method !== 'function' || method.constructor.name !== 'AsyncFunction')
        continue;
      Reflect.set(classType.prototype, methodName, function(...args) {
        const syncStack = {
          stack: ''
        };
        Error.captureStackTrace(syncStack);
        return method.call(this, ...args).catch(e => {
          const stack = syncStack.stack.substring(syncStack.stack.indexOf('\n') + 1);
          const clientStack = stack.substring(stack.indexOf('\n'));
          if (e instanceof Error && e.stack && !e.stack.includes(clientStack))
            e.stack += '\n  -- ASYNC --\n' + stack;
          throw e;
        });
      });
    }
  }

  static addEventListener(emitter: NodeJS.EventEmitter, eventName: string|symbol, handler: (...args: any[]) => void): { emitter: NodeJS.EventEmitter; eventName: string|symbol; handler: (...args: any[]) => void} {
    emitter.on(eventName, handler);
    return { emitter, eventName, handler };
  }

  /**
   * @param {!Array<{emitter: !NodeJS.EventEmitter, eventName: (string|symbol), handler: function(?):void}>} listeners
   */
  static removeEventListeners(listeners: Array<{emitter: NodeJS.EventEmitter; eventName: string|symbol; handler: (...args: any[]) => void}>): void {
    for (const listener of listeners)
      listener.emitter.removeListener(listener.eventName, listener.handler);
    listeners.length = 0;
  }

  static isString(obj: unknown): obj is string {
    return typeof obj === 'string' || obj instanceof String;
  }

  static isNumber(obj: unknown): obj is number {
    return typeof obj === 'number' || obj instanceof Number;
  }

  static async waitForEvent<T extends any>(emitter: NodeJS.EventEmitter, eventName: string|symbol, predicate: (event: T) => boolean, timeout: number, abortPromise: Promise<Error>): Promise<T> {
    let eventTimeout, resolveCallback, rejectCallback;
    const promise = new Promise<T>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    const listener = Helper.addEventListener(emitter, eventName, event => {
      if (!predicate(event))
        return;
      resolveCallback(event);
    });
    if (timeout) {
      eventTimeout = setTimeout(() => {
        rejectCallback(new TimeoutError('Timeout exceeded while waiting for event'));
      }, timeout);
    }
    function cleanup(): void {
      Helper.removeEventListeners([listener]);
      clearTimeout(eventTimeout);
    }
    const result = await Promise.race([promise, abortPromise]).then(r => {
      cleanup();
      return r;
    }, e => {
      cleanup();
      throw e;
    });
    if (result instanceof Error)
      throw result;

    return result;
  }

  /**
   * @template T
   * @param {!Promise<T>} promise
   * @param {string} taskName
   * @param {number} timeout
   * @return {!Promise<T>}
   */
  static async waitWithTimeout<T extends any>(promise: Promise<T>, taskName: string, timeout: number): Promise<T> {
    let reject;
    const timeoutError = new TimeoutError(`waiting for ${taskName} failed: timeout ${timeout}ms exceeded`);
    const timeoutPromise = new Promise<T>((resolve, x) => reject = x);
    let timeoutTimer = null;
    if (timeout)
      timeoutTimer = setTimeout(() => reject(timeoutError), timeout);
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutTimer)
        clearTimeout(timeoutTimer);
    }
  }

  /**
   * @param {!Puppeteer.CDPSession} client
   * @param {string} handle
   * @param {?string} path
   * @return {!Promise<!Buffer>}
   */
  static async readProtocolStream(client: Puppeteer.CDPSession, handle: string, path?: string): Promise<Buffer> {
    let eof = false;
    let file;
    if (path)
      file = await openAsync(path, 'w');
    const bufs = [];
    while (!eof) {
      const response = await client.send('IO.read', {handle});
      eof = response.eof;
      const buf = Buffer.from(response.data, response.base64Encoded ? 'base64' : undefined);
      bufs.push(buf);
      if (path)
        await writeAsync(file, buf);
    }
    if (path)
      await closeAsync(file);
    await client.send('IO.close', {handle});
    let resultBuffer = null;
    try {
      resultBuffer = Buffer.concat(bufs);
    } finally {
      return resultBuffer;
    }
  }

  static promisify = promisify;
}

export = {
  helper: Helper,
  assert,
  debugError
};
