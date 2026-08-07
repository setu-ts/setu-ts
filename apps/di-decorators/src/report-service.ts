import { Injectable } from '@setu-ts/decorator-plugin';

/** One application-wide reporting service. */
@Injectable({ scope: 'singleton', token: 'singleton-report' })
export class SingletonReportService {}

/** One reporting service instance for each manually-created scope. */
@Injectable({ scope: 'scoped', token: 'scoped-report' })
export class ScopedReportService {}
