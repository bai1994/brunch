'use strict';
const child_process = require('child_process'); // eslint-disable-line camelcase
const EventEmitter = require('events');
const debug = require('debug')('brunch:workers');

const workerFile = `${__dirname}/job-processor.js`;

const genId = (() => {
  let counter = 0;

  return () => counter++;
})();

class Queue {
  constructor() {
    this._q = [];
  }

  enqueue(item) {
    this._q.push(item);
  }

  dequeue() {
    return this._q.shift();
  }
}

class WorkerManager {
  constructor(persistent, options, config) {
    this.jobs = new Queue();
    this.workers = [];
    this.pending = {};
    this.events = new EventEmitter();
    this.options = options;
    this.config = config;

    const num = typeof options.jobs === 'string' ? parseInt(options.jobs) : require('os').cpus().length;
    debug(`Spinning ${num} workers`);
    for (let i = 0; i < num; i++) {
      this.fork();
    }

    this._checker = setInterval(() => this.sendMessage(), 1);
  }

  fork() {
    const list = this.workers;
    const pending = this.pending;
    // remove the circular reference in parsed options
    const options = Object.assign({}, this.options, {parent: null});
    // pass parsed options to not make each worker parse the options
    const workerEnv = {BRUNCH_OPTIONS: JSON.stringify(options)};
    const env = Object.assign({}, process.env, workerEnv);
    const wrk = child_process.fork(workerFile, {env}); // eslint-disable-line camelcase
    const events = this.events;
    let idx;
    wrk.on('message', (msg) => {
      if (msg === 'ready') {
        list.push(this);
        idx = list.indexOf(this);
        debug(`Worker ${idx} spawned`);
        pending[idx] = false;
      } else {
        const id = pending[idx];
        pending[idx] = false;
        events.emit(id, msg);
      }
    });
  }

  close() {
    debug('Killing workers');
    clearInterval(this._checker);
    this.workers.forEach(worker => worker.kill('SIGINT'));
  }

  // schedule a `type` operation with `data` for processing
  // returns a promise which will yield the results of the computation
  schedule(type, data) {
    const id = genId();
    this.jobs.enqueue([id, {type, data}]);

    return new Promise((resolve, reject) => {
      this.events.once(id, response => {
        if ('result' in response) {
          resolve(response.result);
        } else {
          reject(new Error(response.error));
        }
      });
    });
  }

  getFreeWorkerIdx() {
    return Object.keys(this.workers).find(idx => this.pending[idx] === false);
  }

  sendMessage() {
    const workerIdx = this.getFreeWorkerIdx();
    if (!workerIdx) return;
    const job = this.jobs.dequeue();
    if (!job) return;
    const worker = this.workers[workerIdx];

    const id = job[0];
    const data = job[1];

    this.pending[workerIdx] = id;
    worker.send(data);
  }
}

module.exports = WorkerManager;