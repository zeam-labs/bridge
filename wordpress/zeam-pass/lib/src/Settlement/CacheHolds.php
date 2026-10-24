<?php

namespace ZeamPass\Settlement;

final class CacheHolds implements Holds
{
    private $cache;

    public function __construct(Cache $cache)
    {
        $this->cache = $cache;
    }

    private static function name($key)
    {
        return 'zeam_pass_mpp_' . sha1((string) $key);
    }

    public function claim($key, $untilMs, $nowMs)
    {
        return (bool) $this->cache->add(self::name($key), ['until' => (int) $untilMs], max(1, intdiv((int) $untilMs - (int) $nowMs, 1000)));
    }

    public function release($key)
    {
        $this->cache->set(self::name($key), 0, 1);
    }

    public function entry($key)
    {
        $e = $this->cache->get(self::name($key));
        return is_array($e) ? $e : null;
    }

    public function mark($key, $from, array $fields)
    {
        $e = $this->entry($key);
        if ($e === null || (isset($e['state']) ? $e['state'] : null) !== $from) {
            return false;
        }
        $this->cache->set(self::name($key), array_merge($e, $fields), max(1, (int) ceil(((int) $e['until'] - (int) floor(microtime(true) * 1000)) / 1000)));
        return true;
    }
}
