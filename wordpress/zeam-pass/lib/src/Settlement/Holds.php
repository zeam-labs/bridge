<?php

namespace ZeamPass\Settlement;

interface Holds
{
    public function claim($key, $untilMs, $nowMs);

    public function release($key);

    public function entry($key);

    public function mark($key, $from, array $fields);
}
