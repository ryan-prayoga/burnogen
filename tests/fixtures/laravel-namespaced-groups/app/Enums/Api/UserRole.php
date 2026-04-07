<?php

namespace App\Enums\Api;

enum UserRole: string
{
    case Member = 'member';
    case Owner = 'owner';
}
