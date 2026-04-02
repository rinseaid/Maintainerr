import { MediaItem, MediaItemType } from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlexApiService } from '../../api/plex-api/plex-api.service';
import {
  TautulliApiService,
  TautulliHistoryItem,
  TautulliHistoryRequestOptions,
  TautulliMetadata,
} from '../../api/tautulli-api/tautulli-api.service';
import { Collection } from '../../collections/entities/collection.entities';
import { TautulliHistoryCache } from '../entities/tautulli-history-cache.entity';
import { MaintainerrLogger } from '../../logging/logs.service';
import {
  Application,
  Property,
  RuleConstants,
} from '../constants/rules.constants';
import { RulesDto } from '../dtos/rules.dto';

@Injectable()
export class TautulliGetterService {
  appProperties: Property[];

  constructor(
    private readonly tautulliApi: TautulliApiService,
    private readonly plexApi: PlexApiService,
    @InjectRepository(Collection)
    private readonly collectionRepository: Repository<Collection>,
    @InjectRepository(TautulliHistoryCache)
    private readonly historyCacheRepo: Repository<TautulliHistoryCache>,
    private readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(TautulliGetterService.name);
    const ruleConstanst = new RuleConstants();
    this.appProperties = ruleConstanst.applications.find(
      (el) => el.id === Application.TAUTULLI,
    ).props;
  }

  // Cap history cache to avoid unbounded growth on large collections (e.g. 3000+ movies)
  private static readonly HISTORY_CACHE_MAX = 500;
  private static readonly HISTORY_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours (prevents cold-cache at 8 AM run)
  private historyCache = new Map<string, TautulliHistoryItem[] | null>();
  private metadataCache = new Map<string, TautulliMetadata>();

  // Bulk pre-fetch cache: populated once per 4-hour window to avoid per-item API calls
  private bulkByRatingKey = new Map<string, TautulliHistoryItem[]>();
  private bulkByParentKey = new Map<string, TautulliHistoryItem[]>();
  private bulkByGrandparentKey = new Map<string, TautulliHistoryItem[]>();
  private bulkHistoryWarmed = false;
  private bulkCachedAt: Date | null = null;
  // Bulk cache TTL: 4 hours (covers all collections in one 8-hr cron cycle,
  // but expires before the next cycle so data stays fresh)
  private static readonly BULK_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

  private setHistoryCache(key: string, value: TautulliHistoryItem[] | null) {
    if (
      !this.historyCache.has(key) &&
      this.historyCache.size >= TautulliGetterService.HISTORY_CACHE_MAX
    ) {
      // Evict oldest entry (Maps preserve insertion order)
      this.historyCache.delete(this.historyCache.keys().next().value);
    }
    this.historyCache.set(key, value);
  }

  clearCache(): void {
    // Clear per-run L1 caches (historyCache, metadataCache).
    // Bulk cache (bulkByRatingKey etc.) is intentionally NOT cleared here —
    // it persists across all collections in a run cycle so we only fetch once.
    this.historyCache.clear();
    this.metadataCache.clear();
  }

  /** Called once before the first collection in each run cycle to expire the bulk cache. */
  clearBulkCache(): void {
    this.bulkByRatingKey.clear();
    this.bulkByParentKey.clear();
    this.bulkByGrandparentKey.clear();
    this.bulkHistoryWarmed = false;
  }

  async warmBulkHistoryCache(): Promise<void> {
    // Reuse bulk cache if it was populated within the last 4 hours
    // (covers all collections in the same 8-hr cron cycle)
    if (this.bulkHistoryWarmed && this.bulkCachedAt) {
      const age = Date.now() - this.bulkCachedAt.getTime();
      if (age < TautulliGetterService.BULK_CACHE_TTL_MS) {
        return;
      }
      // Expired — clear and re-fetch
      this.clearBulkCache();
    }
    this.logger.log("Pre-fetching all Tautulli history for bulk in-memory cache...");
    // Use large page size to minimise the number of HTTP round-trips.
    // MAX_PAGE_SIZE (100) would require 430+ sequential calls for a typical library;
    // 10 000 records per page reduces that to ~5 calls.
    const BULK_PAGE_SIZE = 10000;
    const allHistory: TautulliHistoryItem[] = [];
    let start = 0;
    while (true) {
      const page = await this.tautulliApi.getPaginatedHistory({ start, length: BULK_PAGE_SIZE });
      if (!page?.data?.length) break;
      allHistory.push(...page.data);
      const total = (page as any).recordsFiltered ?? 0;
      if (!total || allHistory.length >= total) break;
      start += BULK_PAGE_SIZE;
    }
    if (allHistory.length === 0) {
      this.bulkHistoryWarmed = true;
      return;
    }
    for (const item of allHistory) {
      const rk = String(item.rating_key);
      if (!this.bulkByRatingKey.has(rk)) this.bulkByRatingKey.set(rk, []);
      this.bulkByRatingKey.get(rk)!.push(item);

      if (item.parent_rating_key) {
        const pk = String(item.parent_rating_key);
        if (!this.bulkByParentKey.has(pk)) this.bulkByParentKey.set(pk, []);
        this.bulkByParentKey.get(pk)!.push(item);
      }

      if (item.grandparent_rating_key) {
        const gpk = String(item.grandparent_rating_key);
        if (!this.bulkByGrandparentKey.has(gpk)) this.bulkByGrandparentKey.set(gpk, []);
        this.bulkByGrandparentKey.get(gpk)!.push(item);
      }
    }
    this.bulkHistoryWarmed = true;
    this.bulkCachedAt = new Date();
    this.logger.log(`Bulk Tautulli history cache warmed: ${allHistory.length} entries indexed`);
  }

  async get(
    id: number,
    libItem: MediaItem,
    dataType?: MediaItemType,
    ruleGroup?: RulesDto,
  ) {
    try {
      const prop = this.appProperties.find((el) => el.id === id);
      let metadata = this.metadataCache.get(libItem.id);
      if (!metadata) {
        metadata = await this.tautulliApi.getMetadata(libItem.id);
        this.metadataCache.set(libItem.id, metadata);
      }
      const collection = await this.collectionRepository.findOne({
        where: { id: ruleGroup.collection.id },
      });
      const tautulliWatchedPercentOverride =
        collection.tautulliWatchedPercentOverride;

      switch (prop.name) {
        case 'seenBy':
        case 'sw_watchers': {
          const history = await this.getHistoryForMetadata(metadata);

          if (history.length > 0) {
            const viewerIds = history
              .filter((x) =>
                tautulliWatchedPercentOverride != null
                  ? x.percent_complete >= tautulliWatchedPercentOverride
                  : x.watched_status == 1,
              )
              .map((el) => el.user_id);

            const uniqueViewerIds = [...new Set(viewerIds)];
            const plexUsernames =
              await this.getPlexUsernamesForIds(uniqueViewerIds);

            return plexUsernames;
          } else {
            return [];
          }
        }
        case 'sw_allEpisodesSeenBy': {
          const users = await this.tautulliApi.getUsers();
          let seasons: TautulliMetadata[];

          if (metadata.media_type !== 'season') {
            seasons = await this.tautulliApi.getChildrenMetadata(
              metadata.rating_key,
            );
          } else {
            seasons = [metadata];
          }

          const allViewers = users.slice();
          for (const season of seasons) {
            const episodes = await this.tautulliApi.getChildrenMetadata(
              season.rating_key,
            );

            for (const episode of episodes) {
              const viewers = await this.tautulliApi.getHistory({
                rating_key: episode.rating_key,
              });

              const arrLength = allViewers.length - 1;
              allViewers
                .slice()
                .reverse()
                .forEach((el, idx) => {
                  if (
                    !viewers?.find(
                      (viewEl) =>
                        (tautulliWatchedPercentOverride != null
                          ? viewEl.percent_complete >=
                            tautulliWatchedPercentOverride
                          : viewEl.watched_status == 1) &&
                        el.user_id === viewEl.user_id,
                    )
                  ) {
                    allViewers.splice(arrLength - idx, 1);
                  }
                });
            }
          }

          if (allViewers.length > 0) {
            const plexUsernames = await this.getPlexUsernamesForIds(
              allViewers.map((x) => x.user_id),
            );
            return plexUsernames;
          }

          return [];
        }
        case 'addDate': {
          return new Date(+metadata.added_at * 1000);
        }
        case 'viewCount':
        case 'sw_amountOfViews': {
          const history = await this.getHistoryForMetadata(metadata);
          const watchedContent = history.filter((x) =>
            tautulliWatchedPercentOverride != null
              ? x.percent_complete >= tautulliWatchedPercentOverride
              : x.watched_status == 1,
          );
          return watchedContent.length;
        }
        case 'lastViewedAt': {
          // get_metadata has a last_viewed_at field which would be easier but it's not correct
          const history = await this.getHistoryForMetadata(metadata);
          const sortedHistory = history
            .filter((x) =>
              tautulliWatchedPercentOverride != null
                ? x.percent_complete >= tautulliWatchedPercentOverride
                : x.watched_status == 1,
            )
            .map((el) => el.stopped)
            .sort()
            .reverse();

          return sortedHistory.length > 0
            ? new Date(sortedHistory[0] * 1000)
            : null;
        }
        case 'sw_viewedEpisodes': {
          const history = await this.getHistoryForMetadata(metadata);

          const watchedEpisodes = history
            .filter((x) =>
              tautulliWatchedPercentOverride != null
                ? x.percent_complete >= tautulliWatchedPercentOverride
                : x.watched_status == 1,
            )
            .map((x) => x.rating_key);

          const uniqueEpisodes = [...new Set(watchedEpisodes)];

          return uniqueEpisodes.length;
        }
        case 'sw_lastWatched': {
          let history = await this.getHistoryForMetadata(metadata);

          history
            .filter((x) =>
              tautulliWatchedPercentOverride != null
                ? x.percent_complete >= tautulliWatchedPercentOverride
                : x.watched_status == 1,
            )
            .sort((a, b) => a.parent_media_index - b.parent_media_index)
            .reverse();

          history = history.filter(
            (el) => el.parent_media_index === history[0].parent_media_index,
          );
          history.sort((a, b) => a.media_index - b.media_index).reverse();

          return history.length > 0
            ? new Date(history[0].stopped * 1000)
            : null;
        }
        default: {
          return null;
        }
      }
    } catch (error) {
      this.logger.warn(
        `Tautulli-Getter - Action failed for '${libItem.title}' with id '${libItem.id}'`,
      );
      this.logger.debug(
        `Tautulli-Getter - Action failed for '${libItem.title}' with id '${libItem.id}'`,
        error,
      );
      return undefined;
    }
  }

  private async getHistoryForMetadata(metadata: TautulliMetadata) {
    const cacheKey = `${metadata.media_type}:${metadata.rating_key}`;

    // L1: in-memory (within a single run)
    if (this.historyCache.has(cacheKey)) {
      return this.historyCache.get(cacheKey);
    }

    // L1.5: bulk in-memory pre-fetch (one fetch covers all items this run)
    if (this.bulkHistoryWarmed) {
      let bulkHistory: TautulliHistoryItem[] | undefined;
      if (metadata.media_type === "movie" || metadata.media_type === "episode") {
        bulkHistory = this.bulkByRatingKey.get(String(metadata.rating_key)) ?? [];
      } else if (metadata.media_type === "season") {
        bulkHistory = this.bulkByParentKey.get(String(metadata.rating_key)) ?? [];
      } else if (metadata.media_type === "show") {
        bulkHistory = this.bulkByGrandparentKey.get(String(metadata.rating_key)) ?? [];
      }
      if (bulkHistory !== undefined) {
        this.setHistoryCache(cacheKey, bulkHistory);
        return bulkHistory;
      }
    }

    // L2: SQLite (across runs, 12-hour TTL)
    const cached = await this.historyCacheRepo.findOne({ where: { cacheKey } });
    const cutoff = new Date(Date.now() - TautulliGetterService.HISTORY_CACHE_TTL_MS);
    if (cached && new Date(cached.cachedAt as unknown as string) >= cutoff) {
      const history = JSON.parse(cached.historyJson) as TautulliHistoryItem[];
      this.setHistoryCache(cacheKey, history);
      return history;
    }

    const options: TautulliHistoryRequestOptions = {};

    if (metadata.media_type == 'movie' || metadata.media_type == 'episode') {
      options.rating_key = metadata.rating_key;
    } else if (metadata.media_type == 'season') {
      options.parent_rating_key = metadata.rating_key;
    } else if (metadata.media_type == 'show') {
      options.grandparent_rating_key = metadata.rating_key;
    } else {
      return [];
    }

    const history = await this.tautulliApi.getHistory(options);

    // Persist to SQLite for next run
    await this.historyCacheRepo.upsert(
      { cacheKey, historyJson: JSON.stringify(history ?? []), cachedAt: new Date() },
      ['cacheKey'],
    );

    this.setHistoryCache(cacheKey, history);
    return history;
  }

  private getPlexUsernamesForIds = async (plexIds: number[]) => {
    const plexUsers = await this.plexApi.getCorrectedUsers();

    return plexIds.reduce((acc, x) => {
      const plexUsername = plexUsers.find((u) => u.plexId === x)?.username;

      if (plexUsername) {
        acc.push(plexUsername);
      }

      return acc;
    }, [] as string[]);
  };
}
