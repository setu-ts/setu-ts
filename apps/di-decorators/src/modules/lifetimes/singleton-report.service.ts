import { Injectable } from '@setu-ts/decorator-plugin';

/** The singleton service token. */
export const SINGLETON_REPORT = 'singleton-report';

/** One instance for the whole application. */
@Injectable({ scope: 'singleton', token: SINGLETON_REPORT })
export class SingletonReportService {}
