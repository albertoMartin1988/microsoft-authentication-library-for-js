/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { SERVER_TELEM_CONSTANTS, CacheSchemaType, Separators } from "../../utils/Constants";
import { CacheManager } from "../../cache/CacheManager";
import { AuthError } from "../../error/AuthError";
import { ServerTelemetryRequest } from "./ServerTelemetryRequest";
import { ServerTelemetryEntity } from "../../cache/entities/ServerTelemetryEntity";
import { StringUtils } from "../../utils/StringUtils";

export class ServerTelemetryManager {
    private cacheManager: CacheManager;
    private apiId: number;
    private correlationId: string;
    private forceRefresh: boolean;
    private telemetryCacheKey: string;

    constructor(telemetryRequest: ServerTelemetryRequest, cacheManager: CacheManager) {
        this.cacheManager = cacheManager;
        this.apiId = telemetryRequest.apiId;
        this.correlationId = telemetryRequest.correlationId;
        this.forceRefresh = telemetryRequest.forceRefresh || false;

        this.telemetryCacheKey = SERVER_TELEM_CONSTANTS.CACHE_KEY + Separators.CACHE_KEY_SEPARATOR + telemetryRequest.clientId;
    }

    /**
     * API to add MSER Telemetry to request
     */
    generateCurrentRequestHeaderValue(): string {
        const forceRefreshInt = this.forceRefresh ? 1 : 0;
        const request = `${this.apiId}${SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR}${forceRefreshInt}`;
        const platformFields = ""; // TODO: Determine what we want to include

        return [SERVER_TELEM_CONSTANTS.SCHEMA_VERSION, request, platformFields].join(SERVER_TELEM_CONSTANTS.CATEGORY_SEPARATOR);
    }

    /**
     * API to add MSER Telemetry for the last failed request
     */
    generateLastRequestHeaderValue(): string {
        const lastRequests = this.getLastRequests();
        
        const maxErrors = ServerTelemetryManager.maxErrorsToSend(lastRequests);
        const failedRequests = lastRequests.failedRequests.slice(0, 2*maxErrors).join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
        const errors = lastRequests.errors.slice(0, maxErrors).join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
        const errorCount = lastRequests.errors.length;

        // Indicate whether this header contains all data or partial data
        const overflow = maxErrors < errorCount ? SERVER_TELEM_CONSTANTS.OVERFLOW_TRUE : SERVER_TELEM_CONSTANTS.OVERFLOW_FALSE;
        const platformFields = [errorCount, overflow].join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);

        return [SERVER_TELEM_CONSTANTS.SCHEMA_VERSION, lastRequests.cacheHits, failedRequests, errors, platformFields].join(SERVER_TELEM_CONSTANTS.CATEGORY_SEPARATOR);
    }

    /**
     * API to cache token failures for MSER data capture
     * @param error 
     */
    cacheFailedRequest(error: AuthError): void {
        const lastRequests = this.getLastRequests();
        lastRequests.failedRequests.push(this.apiId, this.correlationId);
        lastRequests.errors.push(StringUtils.isEmpty(error.suberror)? error.errorCode: error.suberror);

        this.cacheManager.setItem(this.telemetryCacheKey, lastRequests, CacheSchemaType.TELEMETRY);

        return;
    }

    /**
     * Update server telemetry cache entry by incrementing cache hit counter
     */
    incrementCacheHits(): number {
        const lastRequests = this.getLastRequests();
        lastRequests.cacheHits += 1;

        this.cacheManager.setItem(this.telemetryCacheKey, lastRequests, CacheSchemaType.TELEMETRY);
        return lastRequests.cacheHits;
    }

    /**
     * Get the server telemetry entity from cache or initialize a new one
     */
    getLastRequests(): ServerTelemetryEntity { 
        const initialValue: ServerTelemetryEntity = new ServerTelemetryEntity();
        const lastRequests = this.cacheManager.getItem(this.telemetryCacheKey, CacheSchemaType.TELEMETRY) as ServerTelemetryEntity;
        
        return lastRequests || initialValue;
    }

    /**
     * Remove server telemetry cache entry
     */
    clearTelemetryCache(): void {
        const lastRequests = this.getLastRequests();
        const numErrorsFlushed = ServerTelemetryManager.maxErrorsToSend(lastRequests);
        const errorCount = lastRequests.errors.length;
        if (numErrorsFlushed === errorCount) {
            // All errors were sent on last request, clear Telemetry cache
            this.cacheManager.removeItem(this.telemetryCacheKey);
        } else {
            // Partial data was flushed to server, construct a new telemetry cache item with errors that were not flushed
            const serverTelemEntity = new ServerTelemetryEntity();
            serverTelemEntity.failedRequests = lastRequests.failedRequests.slice(numErrorsFlushed*2); // failedRequests contains 2 items for each error
            serverTelemEntity.errors = lastRequests.errors.slice(numErrorsFlushed);
            
            this.cacheManager.setItem(this.telemetryCacheKey, serverTelemEntity, CacheSchemaType.TELEMETRY);
        }
    }

    /**
     * Returns the maximum number of errors that can be flushed to the server in the next network request
     * @param serverTelemetryEntity 
     */
    static maxErrorsToSend(serverTelemetryEntity: ServerTelemetryEntity): number {
        let i;
        let maxErrors = 0;
        let dataSize = 0;
        const errorCount = serverTelemetryEntity.errors.length;
        for (i = 0; i < errorCount; i++) {
            // failedRequests parameter contains pairs of apiId and correlationId, multiply index by 2 to preserve pairs
            const apiId = serverTelemetryEntity.failedRequests[2*i];
            const correlationId = serverTelemetryEntity.failedRequests[2*i + 1];
            const errorCode = serverTelemetryEntity.errors[i];

            // Count number of characters that would be added to header, each character is 1 byte. Add 3 at the end to account for separators
            dataSize += apiId.toString().length + correlationId.toString().length + errorCode.length + 3;

            if (dataSize < SERVER_TELEM_CONSTANTS.MAX_HEADER_BYTES) {
                // Adding this entry to the header would still keep header size below the limit
                maxErrors += 1;
            } else {
                break;
            }
        }

        return maxErrors;
    }
}
