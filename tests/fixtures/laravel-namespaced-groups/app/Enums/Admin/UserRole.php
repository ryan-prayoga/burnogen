<?php

namespace App\Enums\Admin;

enum UserRole: string
{
    case SuperAdmin = 'super-admin';
    case Auditor = 'auditor';
}
