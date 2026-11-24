// Reads macOS Now Playing metadata (title/artist/album/duration/elapsed/artwork)
// via MediaRemote inside /usr/bin/perl (compatible with macOS 15.4+ restrictions).
#import <Foundation/Foundation.h>
#include <dlfcn.h>

typedef void (*GetInfo)(dispatch_queue_t, void (^)(NSDictionary *));
typedef void (*GetPid)(dispatch_queue_t, void (^)(int));

void np_run(void *perl, void *cv) {
  (void)perl; (void)cv;
  void *h = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
  GetInfo f = (GetInfo)dlsym(h, "MRMediaRemoteGetNowPlayingInfo");
  GetPid g = (GetPid)dlsym(h, "MRMediaRemoteGetNowPlayingApplicationPID");
  if (!f || !g) {
    printf("{\"error\":\"MediaRemote unavailable\"}\n");
    fflush(stdout);
    exit(1);
  }
  const char *la = getenv("FOLDSTAGE_NP_LASTART");
  NSString *lastArt = la ? [NSString stringWithUTF8String:la] : @"";
  @autoreleasepool {
    dispatch_semaphore_t s = dispatch_semaphore_create(0);
    __block int pid = 0;
    g(dispatch_get_global_queue(0, 0), ^(int p) {
      pid = p;
      dispatch_semaphore_signal(s);
    });
    dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC));

    __block NSMutableDictionary *o = [NSMutableDictionary dictionary];
    f(dispatch_get_global_queue(0, 0), ^(NSDictionary *d) {
      for (NSString *k in d) {
        id v = d[k];
        NSString *key = [k stringByReplacingOccurrencesOfString:@"kMRMediaRemoteNowPlayingInfo" withString:@""];
        if ([v isKindOfClass:[NSString class]] || [v isKindOfClass:[NSNumber class]]) {
          o[key] = v;
        } else if ([v isKindOfClass:[NSDate class]]) {
          o[key] = @([(NSDate *)v timeIntervalSince1970]);
        }
      }
      NSData *art = d[@"kMRMediaRemoteNowPlayingInfoArtworkData"];
      NSString *aid = [NSString stringWithFormat:@"%@|%@", o[@"ArtworkIdentifier"] ?: @"", o[@"Title"] ?: @""];
      if ([art isKindOfClass:[NSData class]] && art.length < 600000 && ![aid isEqualToString:lastArt]) {
        o[@"art"] = [art base64EncodedStringWithOptions:0];
      }
      dispatch_semaphore_signal(s);
    });
    dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC));

    o[@"pid"] = @(pid);
    o[@"now"] = @([[NSDate date] timeIntervalSince1970]);
    o[@"artKey"] = [NSString stringWithFormat:@"%@|%@", o[@"ArtworkIdentifier"] ?: @"", o[@"Title"] ?: @""];
    NSData *j = [NSJSONSerialization dataWithJSONObject:o options:0 error:nil];
    if (j) {
      fwrite(j.bytes, 1, j.length, stdout);
      fputc('\n', stdout);
      fflush(stdout);
    }
  }
  exit(0);
}
