import { Injectable } from '@setu-ts/decorator-plugin';

export const SINGLETON_REPORT = 'singleton-report';
export const SCOPED_REPORT = 'scoped-report';

/** One instance for the whole application. */
@Injectable({ scope: 'singleton', token: SINGLETON_REPORT })
export class SingletonReportService {}

/** One instance per DI scope the application creates. */
@Injectable({ scope: 'scoped', token: SCOPED_REPORT })
export class ScopedReportService {}
