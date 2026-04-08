<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class ProjectWrappedResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'code' => 'PRJ-1',
            'owner_email' => $this->owner_email,
        ];
    }
}
