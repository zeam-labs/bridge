<?php

if (!defined('ABSPATH')) {
    exit;
}

// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching

const ZEAM_PASS_DB_VERSION = '3';

function zeam_pass_table($name)
{
    global $wpdb;
    return $wpdb->prefix . 'zeam_pass_' . $name;
}

function zeam_pass_install_tables()
{
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $charset = $wpdb->get_charset_collate();
    $channels = zeam_pass_table('channels');
    $gate = zeam_pass_table('gate');
    $replay = zeam_pass_table('replay');
    $meter = zeam_pass_table('meter');
    $held = zeam_pass_table('held');
    dbDelta("CREATE TABLE {$channels} (
  id char(66) NOT NULL,
  record longtext NOT NULL,
  updated bigint(20) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (id)
) {$charset};");
    dbDelta("CREATE TABLE {$gate} (
  name varchar(64) NOT NULL,
  month char(7) NOT NULL DEFAULT '',
  used bigint(20) unsigned NOT NULL DEFAULT 0,
  credit bigint(20) unsigned NOT NULL DEFAULT 0,
  notes longtext NOT NULL,
  updated bigint(20) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (name)
) {$charset};");
    dbDelta("CREATE TABLE {$replay} (
  k varchar(191) NOT NULL,
  expires bigint(20) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (k),
  KEY expires (expires)
) {$charset};");
    dbDelta("CREATE TABLE {$meter} (
  k varchar(80) NOT NULL,
  record longtext NOT NULL,
  updated bigint(20) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (k)
) {$charset};");
    dbDelta("CREATE TABLE {$held} (
  k char(40) NOT NULL,
  expires bigint(20) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (k),
  KEY expires (expires)
) {$charset};");
    update_option('zeam_pass_db', ZEAM_PASS_DB_VERSION, true);
}

function zeam_pass_now_ms()
{
    return (int) floor(microtime(true) * 1000);
}

final class ZeamPassLock
{
    private static function name($key)
    {
        global $wpdb;
        return 'zeam_pass_' . substr(md5($wpdb->prefix . '|' . $key), 0, 40);
    }

    public static function acquire($key, $wait)
    {
        global $wpdb;
        $got = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, %d)', self::name($key), (int) $wait));
        return (string) $got === '1';
    }

    public static function release($key)
    {
        global $wpdb;
        $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', self::name($key)));
    }

    public static function with($key, callable $fn, $wait = 10)
    {
        if (!self::acquire($key, $wait)) {
            throw new RuntimeException(esc_html('ZEAM Bridge could not lock ' . $key));
        }
        try {
            return $fn();
        } finally {
            self::release($key);
        }
    }

    public static function attempt($key, callable $fn)
    {
        if (!self::acquire($key, 0)) {
            return null;
        }
        try {
            return $fn();
        } finally {
            self::release($key);
        }
    }
}

final class ZeamPassChannelStore implements \ZeamPass\Settlement\Store
{
    private static function fail($what)
    {
        global $wpdb;
        throw new RuntimeException(esc_html('ZEAM Bridge could not ' . $what . ($wpdb->last_error ? ': ' . $wpdb->last_error : '')));
    }

    private static function decode($raw)
    {
        $decoded = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
        return is_array($decoded) ? $decoded : null;
    }

    public function get($channelId)
    {
        global $wpdb;
        $id = \ZeamPass\Settlement\ChannelId::key($channelId);
        return self::decode($wpdb->get_var($wpdb->prepare("SELECT record FROM {$wpdb->prefix}zeam_pass_channels WHERE id = %s", $id)));
    }

    public function update($channelId, callable $fn)
    {
        $id = \ZeamPass\Settlement\ChannelId::key($channelId);
        return ZeamPassLock::with('channel:' . $id, function () use ($id, $fn) {
            global $wpdb;
            $table = zeam_pass_table('channels');
            $current = $this->get($id);
            $next = $fn($current);
            if ($next === null) {
                if ($current !== null && $wpdb->delete($table, ['id' => $id], ['%s']) === false) {
                    self::fail('delete a channel');
                }
                return null;
            }
            $ok = $wpdb->replace($table, ['id' => $id, 'record' => \ZeamPass\Settlement\Json::encode($next), 'updated' => zeam_pass_now_ms()], ['%s', '%s', '%d']);
            if ($ok === false) {
                self::fail('save a channel');
            }
            return $next;
        });
    }

    public function list()
    {
        global $wpdb;
        $out = [];
        foreach ((array) $wpdb->get_col("SELECT record FROM {$wpdb->prefix}zeam_pass_channels ORDER BY updated DESC") as $raw) {
            $record = self::decode($raw);
            if ($record !== null) {
                $out[] = $record;
            }
        }
        return $out;
    }

    public static function any()
    {
        global $wpdb;
        return (bool) $wpdb->get_var("SELECT 1 FROM {$wpdb->prefix}zeam_pass_channels LIMIT 1");
    }
}

final class ZeamPassMeterStore implements \ZeamPass\Settlement\Store
{
    private $kind;

    public function __construct($kind)
    {
        $this->kind = (string) $kind;
    }

    private function key($id)
    {
        return $this->kind . ':' . \ZeamPass\Settlement\ChannelId::key($id);
    }

    private static function fail($what)
    {
        global $wpdb;
        throw new RuntimeException(esc_html('ZEAM Bridge could not ' . $what . ($wpdb->last_error ? ': ' . $wpdb->last_error : '')));
    }

    private static function decode($raw)
    {
        $decoded = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
        return is_array($decoded) ? $decoded : null;
    }

    private function read($k)
    {
        global $wpdb;
        return self::decode($wpdb->get_var($wpdb->prepare("SELECT record FROM {$wpdb->prefix}zeam_pass_meter WHERE k = %s", $k)));
    }

    public function get($id)
    {
        return $this->read($this->key($id));
    }

    public function update($id, callable $fn)
    {
        $k = $this->key($id);
        return ZeamPassLock::with('meter:' . $k, function () use ($k, $fn) {
            global $wpdb;
            $table = zeam_pass_table('meter');
            $current = $this->read($k);
            $next = $fn($current);
            if ($next === null) {
                if ($current !== null && $wpdb->delete($table, ['k' => $k], ['%s']) === false) {
                    self::fail('delete a meter record');
                }
                return null;
            }
            if ($wpdb->replace($table, ['k' => $k, 'record' => \ZeamPass\Settlement\Json::encode($next), 'updated' => zeam_pass_now_ms()], ['%s', '%s', '%d']) === false) {
                self::fail('save a meter record');
            }
            return $next;
        });
    }

    public function list()
    {
        global $wpdb;
        $out = [];
        foreach ((array) $wpdb->get_col($wpdb->prepare("SELECT record FROM {$wpdb->prefix}zeam_pass_meter WHERE k LIKE %s", $wpdb->esc_like($this->kind . ':') . '%')) as $raw) {
            $record = self::decode($raw);
            if ($record !== null) {
                $out[] = $record;
            }
        }
        return $out;
    }
}

final class ZeamPassGateStore implements \ZeamPass\Gate\Store
{
    const METER = 'meter-';

    private static function fail($what)
    {
        global $wpdb;
        throw new RuntimeException(esc_html('ZEAM Bridge could not ' . $what . ($wpdb->last_error ? ': ' . $wpdb->last_error : '')));
    }

    private static function meterName($key)
    {
        return strpos((string) $key, self::METER) === 0 ? substr((string) $key, strlen(self::METER)) : null;
    }

    public function get($key)
    {
        global $wpdb;
        if ($key === \ZeamPass\Gate\Admission::SEEN_KEY) {
            $rows = $wpdb->get_results($wpdb->prepare("SELECT k, expires FROM {$wpdb->prefix}zeam_pass_replay WHERE expires >= %d", zeam_pass_now_ms()), ARRAY_A);
            $out = [];
            foreach ((array) $rows as $row) {
                $out[$row['k']] = (int) $row['expires'];
            }
            return $out === [] ? null : $out;
        }
        $name = self::meterName($key);
        if ($name !== null) {
            $row = $wpdb->get_row($wpdb->prepare("SELECT month, used, credit, notes FROM {$wpdb->prefix}zeam_pass_gate WHERE name = %s", $name), ARRAY_A);
            if (!is_array($row)) {
                return null;
            }
            $notes = json_decode((string) $row['notes'], true);
            return ['month' => (string) $row['month'], 'used' => (int) $row['used'], 'credit' => (int) $row['credit'], 'notes' => is_array($notes) ? array_values($notes) : []];
        }
        $value = get_option('zeam_pass_kv_' . md5((string) $key), null);
        return is_array($value) ? $value : null;
    }

    public function update($key, callable $change)
    {
        return ZeamPassLock::with('gate:' . $key, function () use ($key, $change) {
            $current = $this->get($key);
            list($next, $result) = $change($current);
            $this->persist($key, $current, $next);
            return $result;
        });
    }

    private function persist($key, $current, $next)
    {
        global $wpdb;
        if ($key === \ZeamPass\Gate\Admission::SEEN_KEY) {
            $table = zeam_pass_table('replay');
            $current = is_array($current) ? $current : [];
            $next = is_array($next) ? $next : [];
            foreach ($next as $k => $expires) {
                if (!array_key_exists($k, $current) || (int) $current[$k] !== (int) $expires) {
                    if ($wpdb->replace($table, ['k' => (string) $k, 'expires' => (int) $expires], ['%s', '%d']) === false) {
                        self::fail('record a presented authorization');
                    }
                }
            }
            foreach ($current as $k => $_) {
                if (!array_key_exists($k, $next)) {
                    $wpdb->delete($table, ['k' => (string) $k], ['%s']);
                }
            }
            $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->prefix}zeam_pass_replay WHERE expires < %d", zeam_pass_now_ms() - 60000));
            return;
        }
        $name = self::meterName($key);
        if ($name !== null) {
            if (!is_array($next)) {
                return;
            }
            $ok = $wpdb->replace(zeam_pass_table('gate'), [
                'name' => $name,
                'month' => (string) $next['month'],
                'used' => max(0, (int) $next['used']),
                'credit' => max(0, (int) $next['credit']),
                'notes' => wp_json_encode(array_values((array) $next['notes'])),
                'updated' => zeam_pass_now_ms(),
            ], ['%s', '%s', '%d', '%d', '%s', '%d']);
            if ($ok === false) {
                self::fail('save the gate meter');
            }
            return;
        }
        if ($next === null) {
            delete_option('zeam_pass_kv_' . md5((string) $key));
        } else {
            update_option('zeam_pass_kv_' . md5((string) $key), $next, false);
        }
    }
}

final class ZeamPassCache implements \ZeamPass\Settlement\Cache
{
    private static function key($key)
    {
        return 'zeam_pass_c_' . substr(md5((string) $key), 0, 24);
    }

    public function get($key)
    {
        $hit = get_transient(self::key($key));
        return is_array($hit) && array_key_exists('v', $hit) ? $hit['v'] : null;
    }

    public function set($key, $value, $ttlSeconds)
    {
        set_transient(self::key($key), ['v' => $value], max(1, (int) ceil((float) $ttlSeconds)));
    }

    public function add($key, $value, $ttlSeconds)
    {
        $name = 'cache:' . self::key($key);
        if (!ZeamPassLock::acquire($name, 5)) {
            return false;
        }
        try {
            if ($this->get($key)) {
                return false;
            }
            $this->set($key, $value, $ttlSeconds);
            return true;
        } finally {
            ZeamPassLock::release($name);
        }
    }
}

final class ZeamPassHolds implements \ZeamPass\Settlement\Holds
{
    private static function k($key)
    {
        return sha1((string) $key);
    }

    public function claim($key, $untilMs, $nowMs)
    {
        global $wpdb;
        $k = self::k($key);
        $table = zeam_pass_table('held');
        $got = ZeamPassLock::attempt('held:' . $k, function () use ($wpdb, $k, $table, $untilMs, $nowMs) {
            $until = $wpdb->get_var($wpdb->prepare("SELECT expires FROM {$table} WHERE k = %s", $k));
            if ($until !== null && (int) $until > (int) $nowMs) {
                return false;
            }
            if ($wpdb->replace($table, ['k' => $k, 'expires' => (int) $untilMs], ['%s', '%d']) === false) {
                throw new RuntimeException(esc_html('ZEAM Bridge could not hold an MPP charge' . ($wpdb->last_error ? ': ' . $wpdb->last_error : '')));
            }
            $wpdb->query($wpdb->prepare("DELETE FROM {$table} WHERE expires < %d", (int) $nowMs - 60000));
            return true;
        });
        return $got === true;
    }

    public function release($key)
    {
        global $wpdb;
        $wpdb->delete(zeam_pass_table('held'), ['k' => self::k($key)], ['%s']);
    }
}
