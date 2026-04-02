import {
  MediaItem,
  MediaItemType,
  MediaServerType,
  RuleValueType,
} from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { MediaServerFactory } from '../../api/media-server/media-server.factory';
import { Application } from '../constants/rules.constants';
import { RuleDto } from '../dtos/rule.dto';
import { RulesDto } from '../dtos/rules.dto';
import { JellyfinGetterService } from './jellyfin-getter.service';
import { PlexGetterService } from './plex-getter.service';
import { RadarrGetterService } from './radarr-getter.service';
import { SeerrGetterService } from './seerr-getter.service';
import { SonarrGetterService } from './sonarr-getter.service';
import { TautulliGetterService } from './tautulli-getter.service';

@Injectable()
export class ValueGetterService {
  constructor(
    private readonly plexGetter: PlexGetterService,
    private readonly radarrGetter: RadarrGetterService,
    private readonly sonarrGetter: SonarrGetterService,
    private readonly seerrGetter: SeerrGetterService,
    private readonly tautulliGetter: TautulliGetterService,
    private readonly jellyfinGetter: JellyfinGetterService,
    private readonly mediaServerFactory: MediaServerFactory,
  ) {}

  async get(
    [val1, val2]: [number, number],
    libItem: MediaItem,
    ruleGroup?: RulesDto,
    dataType?: MediaItemType,
    currentRule?: RuleDto,
  ): Promise<RuleValueType> {
    switch (val1) {
      // Route both PLEX and JELLYFIN to the configured media server's getter
      // This handles community rules that may reference the wrong server type
      case Application.PLEX:
      case Application.JELLYFIN: {
        const serverType =
          await this.mediaServerFactory.getConfiguredServerType();

        const getter =
          serverType === MediaServerType.JELLYFIN
            ? this.jellyfinGetter
            : serverType === MediaServerType.PLEX
              ? this.plexGetter
              : null;

        return getter?.get(val2, libItem, dataType, ruleGroup) ?? null;
      }
      case Application.RADARR: {
        return await this.radarrGetter.get(
          val2,
          libItem,
          ruleGroup,
          currentRule,
        );
      }
      case Application.SONARR: {
        return await this.sonarrGetter.get(
          val2,
          libItem,
          dataType,
          ruleGroup,
          currentRule,
        );
      }
      case Application.SEERR: {
        return await this.seerrGetter.get(val2, libItem, dataType);
      }
      case Application.TAUTULLI: {
        return await this.tautulliGetter.get(
          val2,
          libItem,
          dataType,
          ruleGroup,
        );
      }
      default: {
        return null;
      }
    }
  }

  async warmCaches(ruleGroup: RulesDto): Promise<void> {
    // Tautulli L1 history/metadata caches — reset each collection run
    this.tautulliGetter.clearCache();
    // Plex in-memory children/users caches — reset each run
    this.plexGetter.clearRunCaches();
    // Bulk Tautulli pre-fetch: fetched once per 4-hour window, shared across all
    // collections in the same cycle. warmBulkHistoryCache() is a no-op if the
    // cache is still fresh (< 4hr old), so safe to call for every collection.
    await this.tautulliGetter.warmBulkHistoryCache();
    // Sonarr/Radarr/metadata caches persist across runs — warm only if cold
    if (ruleGroup.collection?.sonarrSettingsId) {
      await this.sonarrGetter.warmSeriesCache(
        ruleGroup.collection.sonarrSettingsId,
      );
    }
    if (ruleGroup.collection?.radarrSettingsId) {
      await this.radarrGetter.warmMoviesCache(
        ruleGroup.collection.radarrSettingsId,
      );
    }
  }

  clearCaches(): void {
    // Tautulli history resets each run — watch state changes in real time.
    this.tautulliGetter.clearCache();
    this.plexGetter.clearRunCaches();
    // Sonarr/Radarr full objects are large — clear between run cycles to avoid
    // unbounded memory growth. The warm-guard prevents redundant bulk fetches
    // within a single run cycle when multiple collections share the same instance.
    this.sonarrGetter.clearSeriesCache();
    this.radarrGetter.clearMoviesCache();
    // Metadata ID resolution (TMDB/TVDB lookups) persists for the lifetime of
    // the process — these are tiny objects and never change unless you rematch
    // in Plex, eliminating the most expensive external API calls on subsequent runs.
  }
}
