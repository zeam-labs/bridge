<?php

namespace ZeamPass\Settlement;

final class MppException extends \RuntimeException
{
    public $type;
    public $detail;
    public $more;

    public function __construct($type, $detail, array $more = [])
    {
        parent::__construct('payment refused');
        $this->type = (string) $type;
        $this->detail = (string) $detail;
        $this->more = $more;
    }
}
